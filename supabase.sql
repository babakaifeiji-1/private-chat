-- 私密聊天室 - Supabase 数据库初始化脚本
-- 在 Supabase 控制台 SQL Editor 中整段粘贴并运行一次即可。
--
-- 设计：
--   * 表开启 RLS 且不建任何策略 => 匿名用户无法直接读写表、无法列出全部数据
--   * 只能通过下面的函数访问，且必须提供 room（由房间名+口令在浏览器中派生的 64 位十六进制哈希）
--   * 服务器只保存密文，看不到任何明文、昵称或图片内容

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  room       text        not null check (room ~ '^[0-9a-f]{64}$'),
  payload    text        not null check (length(payload) <= 20000),
  created_at timestamptz not null default now()
);
create index if not exists messages_room_id_idx on public.messages (room, id);

create table if not exists public.blobs (
  id         uuid        primary key default gen_random_uuid(),
  room       text        not null check (room ~ '^[0-9a-f]{64}$'),
  data       text        not null check (length(data) <= 3000000),
  created_at timestamptz not null default now()
);
create index if not exists blobs_room_idx on public.blobs (room);

alter table public.messages enable row level security;
alter table public.blobs    enable row level security;
revoke all on public.messages from anon, authenticated;
revoke all on public.blobs    from anon, authenticated;

-- 发送一条（加密后的）消息，返回消息 id
create or replace function public.send_message(p_room text, p_payload text)
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.messages (room, payload) values (p_room, p_payload) returning id;
$$;

-- 拉取消息：
--   p_after  不为空 => 返回 id > p_after 的新消息（升序）
--   否则           => 返回 id < p_before（为空则不限）的最近 p_limit 条（升序）
create or replace function public.get_messages(
  p_room   text,
  p_after  bigint default null,
  p_before bigint default null,
  p_limit  int    default 50
)
returns table (id bigint, payload text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  if p_after is not null then
    return query
      select m.id, m.payload, m.created_at from public.messages m
      where m.room = p_room and m.id > p_after
      order by m.id asc limit p_limit;
  else
    return query
      select s.id, s.payload, s.created_at from (
        select m.id, m.payload, m.created_at from public.messages m
        where m.room = p_room and (p_before is null or m.id < p_before)
        order by m.id desc limit p_limit
      ) s order by s.id asc;
  end if;
end;
$$;

-- 上传加密图片，返回图片 id
create or replace function public.put_blob(p_room text, p_data text)
returns uuid
language sql
security definer
set search_path = public
as $$
  insert into public.blobs (room, data) values (p_room, p_data) returning id;
$$;

-- 读取加密图片（必须同时知道 room 和 id）
create or replace function public.get_blob(p_room text, p_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select b.data from public.blobs b where b.room = p_room and b.id = p_id;
$$;

revoke all on function public.send_message(text, text)                    from public;
revoke all on function public.get_messages(text, bigint, bigint, int)     from public;
revoke all on function public.put_blob(text, text)                        from public;
revoke all on function public.get_blob(text, uuid)                        from public;
grant execute on function public.send_message(text, text)                 to anon, authenticated;
grant execute on function public.get_messages(text, bigint, bigint, int)  to anon, authenticated;
grant execute on function public.put_blob(text, text)                     to anon, authenticated;
grant execute on function public.get_blob(text, uuid)                     to anon, authenticated;
