-- Cuenta G pasa a llamarse Cuenta Spin (2026-11-03). La clase CUENTA_G no cambia.
UPDATE public.cuentas_financieras SET nombre = 'Cuenta Spin' WHERE clase = 'CUENTA_G' AND nombre = 'Cuenta G';
