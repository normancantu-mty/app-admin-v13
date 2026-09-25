do $$
declare d text;
begin
  d := pg_get_functiondef('agente.guardian_lineas(text, boolean)'::regprocedure);
  d := replace(d, 'from agente.salud where clave = ''puente''', 'from agente.salud s where s.clave = ''puente''');
  execute d;
end $$;
