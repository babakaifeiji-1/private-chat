-- 私密聊天室 - Supabase 数据库脚本（v3）
-- 在 Supabase 控制台 SQL Editor 中整段粘贴并运行。可重复运行；从旧版本升级不会删除已有数据。
--
-- 设计：
--   * 所有表开启 RLS 且不建策略，匿名用户无法直接读写表，只能调用下面的函数
--   * 调用函数必须提供 room（由邀请链接密钥在浏览器中派生的哈希），服务器只存密文
--   * 撤回需要发送者设备上的私有令牌（服务器只存其哈希），别人无法撤回你的消息
--   * 保留期限（天）是明文，服务器据此自动清理过期消息和图片

create sequence if not exists public.chat_rev_seq;

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  room       text        not null check (room ~ '^[0-9a-f]{64}$'),
  payload    text        not null check (length(payload) <= 20000),
  created_at timestamptz not null default now()
);
alter table public.messages add column if not exists rev        bigint  not null default nextval('public.chat_rev_seq');
alter table public.messages add column if not exists owner_hash text;
alter table public.messages add column if not exists blob_id    uuid;
alter table public.messages add column if not exists recalled   boolean not null default false;
create index if not exists messages_room_id_idx      on public.messages (room, id);
create index if not exists messages_room_rev_idx     on public.messages (room, rev);
create index if not exists messages_room_created_idx on public.messages (room, created_at);

create table if not exists public.blobs (
  id         uuid        primary key default gen_random_uuid(),
  room       text        not null check (room ~ '^[0-9a-f]{64}$'),
  data       text        not null check (length(data) <= 3000000),
  created_at timestamptz not null default now()
);
create index if not exists blobs_room_idx         on public.blobs (room);
create index if not exists blobs_room_created_idx on public.blobs (room, created_at);

create table if not exists public.rooms (
  room           text        primary key check (room ~ '^[0-9a-f]{64}$'),
  name_payload   text        check (name_payload is null or length(name_payload) <= 2000),
  retention_days int         check (retention_days is null or retention_days between 1 and 3650),
  cleared_upto   bigint      not null default 0,
  rev            bigint      not null default nextval('public.chat_rev_seq'),
  updated_at     timestamptz not null default now()
);

-- 在线状态：cid 是设备私有令牌的哈希（每个聊天室不同，无法关联到人），payload 是加密的名字
create table if not exists public.presence (
  room      text        not null check (room ~ '^[0-9a-f]{64}$'),
  cid       text        not null check (cid ~ '^[0-9a-f]{64}$'),
  payload   text        not null check (length(payload) <= 2000),
  last_seen timestamptz not null default now(),
  primary key (room, cid)
);
alter table public.presence add column if not exists ip text;

alter table public.messages enable row level security;
alter table public.blobs    enable row level security;
alter table public.rooms    enable row level security;
alter table public.presence enable row level security;
revoke all on public.messages, public.blobs, public.rooms, public.presence from anon, authenticated;
revoke all on sequence public.chat_rev_seq from anon, authenticated;

-- 旧版本函数（签名变化）
drop function if exists public.send_message(text, text);
drop function if exists public.get_messages(text, bigint, bigint, int);

-- 内部：按保留期限清理过期数据（不对外开放）
create or replace function public._purge_room(p_room text)
returns void language plpgsql security definer set search_path = public as $$
declare d int;
begin
  select retention_days into d from public.rooms where room = p_room;
  if d is not null then
    delete from public.blobs    where room = p_room and created_at < now() - make_interval(days => d);
    delete from public.messages where room = p_room and created_at < now() - make_interval(days => d);
  end if;
end $$;

-- 内部：房间元数据 JSON
create or replace function public._room_json(p_room text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('name_payload', r.name_payload, 'retention_days', r.retention_days,
                           'cleared_upto', r.cleared_upto, 'rev', r.rev)
  from public.rooms r where r.room = p_room;
$$;

-- 发送消息
create or replace function public.send_message(p_room text, p_payload text, p_owner_hash text, p_blob_id uuid default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if p_owner_hash is null or p_owner_hash !~ '^[0-9a-f]{64}$' then raise exception 'bad owner hash'; end if;
  perform public._purge_room(p_room);
  insert into public.messages (room, payload, owner_hash, blob_id)
  values (p_room, p_payload, p_owner_hash, p_blob_id) returning id into v;
  return v;
end $$;

-- 首屏 / 加载更早：返回 {messages, room, max_rev}
create or replace function public.get_messages(p_room text, p_before bigint default null, p_limit int default 50)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public._purge_room(p_room);
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  return json_build_object(
    'messages', coalesce((
      select json_agg(s order by s.id) from (
        select m.id, m.rev, m.payload, m.created_at, m.recalled from public.messages m
        where m.room = p_room and (p_before is null or m.id < p_before)
        order by m.id desc limit p_limit) s), '[]'::json),
    'room', public._room_json(p_room),
    'max_rev', greatest(
      coalesce((select max(m.rev) from public.messages m where m.room = p_room), 0),
      coalesce((select r.rev from public.rooms r where r.room = p_room), 0)));
end $$;

-- 增量同步：rev > p_after_rev 的新消息/撤回，以及房间信息变化
create or replace function public.get_changes(p_room text, p_after_rev bigint)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'messages', coalesce((
      select json_agg(s order by s.rev) from (
        select m.id, m.rev, m.payload, m.created_at, m.recalled from public.messages m
        where m.room = p_room and m.rev > p_after_rev
        order by m.rev asc limit 200) s), '[]'::json),
    'room', (select public._room_json(p_room) from public.rooms r where r.room = p_room and r.rev > p_after_rev));
$$;

-- 撤回：校验发送者令牌，内容替换为“已撤回”的密文，并删除关联图片
create or replace function public.recall_message(p_room text, p_id bigint, p_token text, p_payload text)
returns boolean language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select m.blob_id into b from public.messages m
  where m.room = p_room and m.id = p_id and not m.recalled
    and m.owner_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;
  if not found then return false; end if;
  update public.messages set payload = p_payload, recalled = true, blob_id = null,
         rev = nextval('public.chat_rev_seq')
  where room = p_room and id = p_id;
  if b is not null then delete from public.blobs where id = b and room = p_room; end if;
  return true;
end $$;

-- 修改聊天室名称（密文）
create or replace function public.set_room_name(p_room text, p_name_payload text)
returns void language sql security definer set search_path = public as $$
  insert into public.rooms (room, name_payload) values (p_room, p_name_payload)
  on conflict (room) do update set name_payload = excluded.name_payload,
    rev = nextval('public.chat_rev_seq'), updated_at = now();
$$;

-- 设置消息保留天数（null = 永久），并立即清理
create or replace function public.set_retention(p_room text, p_days int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.rooms (room, retention_days) values (p_room, p_days)
  on conflict (room) do update set retention_days = excluded.retention_days,
    rev = nextval('public.chat_rev_seq'), updated_at = now();
  perform public._purge_room(p_room);
end $$;

-- 清空聊天室全部消息和图片
create or replace function public.clear_room(p_room text)
returns void language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  select coalesce(max(id), 0) into v from public.messages where room = p_room;
  delete from public.messages where room = p_room;
  delete from public.blobs    where room = p_room;
  insert into public.rooms (room, cleared_upto) values (p_room, v)
  on conflict (room) do update set cleared_upto = greatest(public.rooms.cleared_upto, excluded.cleared_upto),
    rev = nextval('public.chat_rev_seq'), updated_at = now();
end $$;

-- 存储占用
create or replace function public.room_usage(p_room text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'messages', (select count(*) from public.messages where room = p_room),
    'images',   (select count(*) from public.blobs where room = p_room),
    'bytes',    coalesce((select sum(octet_length(payload)) from public.messages where room = p_room), 0)
              + coalesce((select sum(octet_length(data)) from public.blobs where room = p_room), 0),
    'db_bytes', pg_database_size(current_database()));
$$;

-- 内部：从请求头取访问者 IP（cf-connecting-ip 由 Cloudflare 设置，不能被客户端伪造，优先使用）
create or replace function public._client_ip()
returns text language plpgsql stable set search_path = public as $$
declare h json; v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if h is null then return null; end if;
  v := coalesce(nullif(trim(h->>'cf-connecting-ip'), ''),
                nullif(trim(split_part(h->>'x-forwarded-for', ',', 1)), ''),
                nullif(trim(h->>'x-real-ip'), ''));
  if v is null or v !~ '^[0-9A-Fa-f:.]{2,45}$' then return null; end if;
  return v;
end $$;

-- 心跳：更新自己的在线状态（含服务器识别的 IP），返回 40 秒内活跃的成员
-- 离线 10 分钟后记录（包括 IP）自动删除
create or replace function public.heartbeat(p_room text, p_secret text, p_payload text)
returns json language plpgsql security definer set search_path = public as $$
declare v_cid text := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
        v_ip  text := public._client_ip();
begin
  if length(p_secret) < 32 then raise exception 'bad secret'; end if;
  insert into public.presence (room, cid, payload, last_seen, ip) values (p_room, v_cid, p_payload, now(), v_ip)
  on conflict (room, cid) do update set payload = excluded.payload, last_seen = now(), ip = excluded.ip;
  delete from public.presence where room = p_room and last_seen < now() - interval '10 minutes';
  return coalesce((select json_agg(json_build_object('cid', p.cid, 'payload', p.payload, 'ip', p.ip) order by p.cid)
                   from public.presence p
                   where p.room = p_room and p.last_seen > now() - interval '40 seconds'), '[]'::json);
end $$;

-- 离开（关闭页面 / 切换聊天室）
create or replace function public.leave_presence(p_room text, p_secret text)
returns void language sql security definer set search_path = public as $$
  delete from public.presence where room = p_room and cid = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
$$;

-- 上传 / 读取加密图片
create or replace function public.put_blob(p_room text, p_data text)
returns uuid language sql security definer set search_path = public as $$
  insert into public.blobs (room, data) values (p_room, p_data) returning id;
$$;

create or replace function public.get_blob(p_room text, p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select b.data from public.blobs b where b.room = p_room and b.id = p_id;
$$;

-- 权限：Supabase 默认会把新函数授权给 anon，这里先全部收回再按需开放
revoke all on function public._purge_room(text)                           from public, anon, authenticated;
revoke all on function public._room_json(text)                            from public, anon, authenticated;
revoke all on function public.send_message(text, text, text, uuid)        from public, anon, authenticated;
revoke all on function public.get_messages(text, bigint, int)             from public, anon, authenticated;
revoke all on function public.get_changes(text, bigint)                   from public, anon, authenticated;
revoke all on function public.recall_message(text, bigint, text, text)    from public, anon, authenticated;
revoke all on function public.set_room_name(text, text)                   from public, anon, authenticated;
revoke all on function public.set_retention(text, int)                    from public, anon, authenticated;
revoke all on function public.clear_room(text)                            from public, anon, authenticated;
revoke all on function public.room_usage(text)                            from public, anon, authenticated;
revoke all on function public._client_ip()                                from public, anon, authenticated;
revoke all on function public.heartbeat(text, text, text)                 from public, anon, authenticated;
revoke all on function public.leave_presence(text, text)                  from public, anon, authenticated;
grant execute on function public.heartbeat(text, text, text)              to anon, authenticated;
grant execute on function public.leave_presence(text, text)               to anon, authenticated;
revoke all on function public.put_blob(text, text)                        from public, anon, authenticated;
revoke all on function public.get_blob(text, uuid)                        from public, anon, authenticated;
grant execute on function public.send_message(text, text, text, uuid)     to anon, authenticated;
grant execute on function public.get_messages(text, bigint, int)          to anon, authenticated;
grant execute on function public.get_changes(text, bigint)                to anon, authenticated;
grant execute on function public.recall_message(text, bigint, text, text) to anon, authenticated;
grant execute on function public.set_room_name(text, text)                to anon, authenticated;
grant execute on function public.set_retention(text, int)                 to anon, authenticated;
grant execute on function public.clear_room(text)                         to anon, authenticated;
grant execute on function public.room_usage(text)                         to anon, authenticated;
grant execute on function public.put_blob(text, text)                     to anon, authenticated;
grant execute on function public.get_blob(text, uuid)                     to anon, authenticated;
