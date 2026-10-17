-- Magister: base de datos de profesionales
-- Ejecutar en el SQL Editor de Supabase

-- 1. Tabla de profesionales
create table if not exists profesionales (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  nombre text not null,
  oficio text not null,
  descripcion text,
  telefono text,
  whatsapp text,
  ciudad text,
  departamento text,
  foto_url text,
  precio_desde numeric,
  verificado boolean default false,
  user_id uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 2. Tabla de reseñas
create table if not exists resenas (
  id uuid primary key default gen_random_uuid(),
  profesional_id uuid references profesionales(id) on delete cascade,
  autor_nombre text,
  calificacion int check (calificacion >= 1 and calificacion <= 5),
  comentario text,
  created_at timestamptz default now()
);

-- 3. RLS: lectura pública, escritura del dueño
alter table profesionales enable row level security;
drop policy if exists "lectura publica prof" on profesionales;
create policy "lectura publica prof" on profesionales for select using (true);
drop policy if exists "dueno prof" on profesionales for all;
create policy "dueno prof" on profesionales for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table resenas enable row level security;
drop policy if exists "lectura publica res" on resenas;
create policy "lectura publica res" on resenas for select using (true);
drop policy if exists "insert res" on resenas;
create policy "insert res" on resenas for insert with check (true);
