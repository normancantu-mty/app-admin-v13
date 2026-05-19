-- Soft-state for tickets (anulación sin DELETE).
alter table public.transacciones_tickets
  add column if not exists status text not null default 'ACTIVO';

comment on column public.transacciones_tickets.status is 'ACTIVO | ANULADO — operaciones usan UPDATE, nunca DELETE del header comercial.';
