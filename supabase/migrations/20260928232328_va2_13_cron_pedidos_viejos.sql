select cron.schedule('pedidos-viejos', '15 10 * * *', 'select agente.cerrar_pedidos_viejos(true)');
