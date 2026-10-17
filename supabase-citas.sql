-- Magister citas: base de datos
-- Ejecutar en el SQL Editor de Supabase

-- 1. Perfiles
create table if not exists citas_perfiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  nombre text not null,
  edad int check (edad >= 18),
  genero text check (genero in ('hombre','mujer')),
  busca text check (busca in ('hombres','mujeres','todos')),
  bio text,
  foto_url text,
  ciudad text,
  created_at timestamptz default now()
);

-- 2. Likes
create table if not exists citas_likes (
  id uuid primary key default gen_random_uuid(),
  de_user_id uuid references auth.users(id),
  para_perfil_id uuid references citas_perfiles(id) on delete cascade,
  tipo text check (tipo in ('like','pass')),
  created_at timestamptz default now(),
  unique(de_user_id, para_perfil_id)
);

-- 3. Matches
create table if not exists citas_matches (
  id uuid primary key default gen_random_uuid(),
  user1_id uuid references auth.users(id),
  user2_id uuid references auth.users(id),
  created_at timestamptz default now(),
  unique(user1_id, user2_id)
);

-- 4. Mensajes
create table if not exists citas_mensajes (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references citas_matches(id) on delete cascade,
  de_user_id uuid references auth.users(id),
  texto text not null,
  created_at timestamptz default now()
);

-- RLS
alter table citas_perfiles enable row level security;
create policy "ver perfiles" on citas_perfiles for select using (true);
create policy "insert perfil" on citas_perfiles for insert with check (true);
create policy "update propio" on citas_perfiles for update using (auth.uid() = user_id);

alter table citas_likes enable row level security;
create policy "likes todo" on citas_likes for all using (true) with check (true);

alter table citas_matches enable row level security;
create policy "matches todo" on citas_matches for all using (true) with check (true);

alter table citas_mensajes enable row level security;
create policy "msgs todo" on citas_mensajes for all using (true) with check (true);

-- Bucket de fotos
insert into storage.buckets (id, name, public)
values ('citas-fotos', 'citas-fotos', true)
on conflict (id) do nothing;

drop policy if exists "ver citas fotos" on storage.objects;
create policy "ver citas fotos" on storage.objects for select using (bucket_id = 'citas-fotos');
drop policy if exists "subir citas fotos" on storage.objects;
create policy "subir citas fotos" on storage.objects for insert with check (bucket_id = 'citas-fotos');
