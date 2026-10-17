-- Permitir registro sin autenticación (temporal para MVP)
-- Ejecutar en el SQL Editor de Supabase

drop policy if exists "insert prof anon" on profesionales;
create policy "insert prof anon" on profesionales for insert with check (true);
