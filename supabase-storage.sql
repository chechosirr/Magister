-- Bucket para fotos de perfil de profesionales
-- Ejecutar en el SQL Editor de Supabase

insert into storage.buckets (id, name, public)
values ('fotos-perfil', 'fotos-perfil', true)
on conflict (id) do nothing;

-- Política: cualquiera puede ver, cualquiera puede subir (MVP)
drop policy if exists "ver fotos" on storage.objects;
create policy "ver fotos" on storage.objects for select using (bucket_id = 'fotos-perfil');

drop policy if exists "subir fotos" on storage.objects;
create policy "subir fotos" on storage.objects for insert with check (bucket_id = 'fotos-perfil');
