-- =====================================================
-- 과제 8 — MY MEMO 패스키 서버 테이블
--
-- 적용: Supabase 대시보드 → SQL Editor → 이 파일 전체 붙여 넣기 → Run
--
-- 원칙
--  1. 비밀번호 칼럼은 어디에도 없다. 저장하는 것은 패스키 공개키뿐이다.
--  2. 모든 테이블에 RLS를 켜고 허용 규칙(policy)을 하나도 만들지 않는다.
--  3. 공개 키(anon / authenticated)에는 권한을 주지 않는다.
--     → 브라우저에서 공개 키로 테이블을 직접 읽으면 거절된다.
--  4. 테이블은 Edge Function(service_role)만 읽고 쓴다.
-- =====================================================


-- 사이트 계정 (메모의 주인)
create table public.users (
  id               bigint generated always as identity primary key,
  username         text not null unique
                   check (username ~ '^[a-z0-9-]{2,32}$'),
  webauthn_user_id text not null unique,        -- 패스키 안에 들어가는 무작위 사용자 핸들
  created_at       timestamptz not null default now()
);


-- 패스키 (공개키만 저장)
create table public.credentials (
  id           text primary key,                -- credential ID (base64url)
  user_id      bigint not null references public.users (id) on delete cascade,
  public_key   text not null,                   -- COSE 공개키 (base64url). 개인키는 기기 밖으로 나오지 않는다
  counter      bigint not null default 0,
  transports   text[],
  device_type  text,                            -- singleDevice | multiDevice
  backed_up    boolean not null default false,
  aaguid       text,                            -- 어디에 저장됐는지 알려 주는 값
  name         text not null
               check (char_length(name) between 1 and 40),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);


-- 일회용 질문 (challenge). 확인할 때 꺼내면서 바로 지운다
create table public.challenges (
  id               text primary key,            -- 브라우저에 돌려주는 질문 번호
  challenge        text not null,               -- 서버가 만든 무작위 질문 (base64url)
  kind             text not null
                   check (kind in ('register', 'login')),
  user_id          bigint references public.users (id) on delete cascade,
  username         text,                        -- 첫 등록일 때 만들 계정 이름
  webauthn_user_id text,                        -- 첫 등록일 때 쓸 사용자 핸들
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);


-- 로그인 세션. 토큰 원문이 아니라 SHA-256 해시만 저장
create table public.sessions (
  token_hash    text primary key,
  user_id       bigint not null references public.users (id) on delete cascade,
  credential_id text not null references public.credentials (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);


-- 비공개 메모 (한 줄)
create table public.memos (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references public.users (id) on delete cascade,
  body       text not null
             check (char_length(body) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);


create index credentials_user_id_idx on public.credentials (user_id);
create index sessions_user_id_idx    on public.sessions (user_id);
create index memos_user_id_idx       on public.memos (user_id);
create index challenges_expires_idx  on public.challenges (expires_at);


-- -----------------------------------------------------
-- RLS: 켜기만 하고 policy는 만들지 않는다 → 공개 키로는 한 줄도 못 읽는다
-- -----------------------------------------------------
alter table public.users       enable row level security;
alter table public.credentials enable row level security;
alter table public.challenges  enable row level security;
alter table public.sessions    enable row level security;
alter table public.memos       enable row level security;


-- -----------------------------------------------------
-- 권한: 공개 키 역할은 전부 회수, 서버 전용 역할(service_role)에만 부여
-- -----------------------------------------------------
revoke all on
  public.users, public.credentials, public.challenges, public.sessions, public.memos
from anon, authenticated;

grant select, insert, update, delete on
  public.users, public.credentials, public.challenges, public.sessions, public.memos
to service_role;

grant usage, select on all sequences in schema public to service_role;
