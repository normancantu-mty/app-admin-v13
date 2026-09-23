export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      auditoria_logs: {
        Row: {
          creado_en: string
          datos_antes: Json | null
          datos_despues: Json
          id: string
          id_registro: string
          operacion: string
          rol: string | null
          tabla: string
          usuario: string
        }
        Insert: {
          creado_en?: string
          datos_antes?: Json | null
          datos_despues: Json
          id?: string
          id_registro: string
          operacion: string
          rol?: string | null
          tabla: string
          usuario: string
        }
        Update: {
          creado_en?: string
          datos_antes?: Json | null
          datos_despues?: Json
          id?: string
          id_registro?: string
          operacion?: string
          rol?: string | null
          tabla?: string
          usuario?: string
        }
        Relationships: []
      }
      avisos_captura: {
        Row: {
          cerrado_en: string | null
          cerrado_por: string | null
          creado_en: string
          datos_capturados: Json | null
          estado: string
          id: string
          id_entidad: string
          id_registro: string | null
          mensaje: string
          motivo_cierre: string | null
          severidad: string
          tabla: string | null
          tipo: string
          usuario_creador: string
        }
        Insert: {
          cerrado_en?: string | null
          cerrado_por?: string | null
          creado_en?: string
          datos_capturados?: Json | null
          estado?: string
          id?: string
          id_entidad: string
          id_registro?: string | null
          mensaje: string
          motivo_cierre?: string | null
          severidad: string
          tabla?: string | null
          tipo: string
          usuario_creador?: string
        }
        Update: {
          cerrado_en?: string | null
          cerrado_por?: string | null
          creado_en?: string
          datos_capturados?: Json | null
          estado?: string
          id?: string
          id_entidad?: string
          id_registro?: string | null
          mensaje?: string
          motivo_cierre?: string | null
          severidad?: string
          tabla?: string | null
          tipo?: string
          usuario_creador?: string
        }
        Relationships: [
          {
            foreignKeyName: "avisos_captura_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "avisos_captura_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "avisos_captura_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "avisos_captura_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "avisos_captura_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      bot_borradores: {
        Row: {
          creado_en: string
          estado: string
          id: string
          id_registro: string | null
          chat_id: number | null
          payload: Json
          resuelto_en: string | null
          sello: string
          telegram_id: number
        }
        Insert: {
          creado_en?: string
          estado?: string
          id?: string
          id_registro?: string | null
          chat_id?: number | null
          payload: Json
          resuelto_en?: string | null
          sello: string
          telegram_id: number
        }
        Update: {
          creado_en?: string
          estado?: string
          id?: string
          id_registro?: string | null
          chat_id?: number | null
          payload?: Json
          resuelto_en?: string | null
          sello?: string
          telegram_id?: number
        }
        Relationships: []
      }
      bot_categorias: {
        Row: {
          activa: boolean
          ayuda: string
          columna: string
          creada_en: string
          creada_por: string
          nombre: string
          tipo_movimiento: string
        }
        Insert: {
          activa?: boolean
          ayuda?: string
          columna?: string
          creada_en?: string
          creada_por?: string
          nombre: string
          tipo_movimiento?: string
        }
        Update: {
          activa?: boolean
          ayuda?: string
          columna?: string
          creada_en?: string
          creada_por?: string
          nombre?: string
          tipo_movimiento?: string
        }
        Relationships: []
      }
      bot_identidades: {
        Row: {
          activo: boolean
          creado_en: string
          creado_por: string | null
          etiqueta: string
          id: string
          id_cuenta_destino: string
          id_entidad: string
          requiere_aprobacion: boolean
          telegram_id: number
        }
        Insert: {
          activo?: boolean
          creado_en?: string
          creado_por?: string | null
          etiqueta: string
          id?: string
          id_cuenta_destino: string
          id_entidad: string
          requiere_aprobacion?: boolean
          telegram_id: number
        }
        Update: {
          activo?: boolean
          creado_en?: string
          creado_por?: string | null
          etiqueta?: string
          id?: string
          id_cuenta_destino?: string
          id_entidad?: string
          requiere_aprobacion?: boolean
          telegram_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "bot_identidades_id_cuenta_destino_fkey"
            columns: ["id_cuenta_destino"]
            isOneToOne: false
            referencedRelation: "cuentas_financieras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_identidades_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_identidades_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "bot_identidades_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "bot_identidades_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "bot_identidades_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      catalogo_productos: {
        Row: {
          costo_unitario: number | null
          es_materia_prima: boolean
          id: string
          ml_por_unidad: number | null
          nombre: string
          sku: string
          tipo: string
          unidad_medida: string | null
        }
        Insert: {
          costo_unitario?: number | null
          es_materia_prima?: boolean
          id?: string
          ml_por_unidad?: number | null
          nombre: string
          sku: string
          tipo: string
          unidad_medida?: string | null
        }
        Update: {
          costo_unitario?: number | null
          es_materia_prima?: boolean
          id?: string
          ml_por_unidad?: number | null
          nombre?: string
          sku?: string
          tipo?: string
          unidad_medida?: string | null
        }
        Relationships: []
      }
      conteo_detalles: {
        Row: {
          cubeta: string
          id: string
          id_conteo: string
          id_producto: string
          libro_decia: number
          piezas_contadas: number
        }
        Insert: {
          cubeta?: string
          id?: string
          id_conteo: string
          id_producto: string
          libro_decia: number
          piezas_contadas: number
        }
        Update: {
          cubeta?: string
          id?: string
          id_conteo?: string
          id_producto?: string
          libro_decia?: number
          piezas_contadas?: number
        }
        Relationships: [
          {
            foreignKeyName: "conteo_detalles_id_conteo_fkey"
            columns: ["id_conteo"]
            isOneToOne: false
            referencedRelation: "conteos_fisicos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conteo_detalles_id_conteo_fkey"
            columns: ["id_conteo"]
            isOneToOne: false
            referencedRelation: "v_conteo_ultimo"
            referencedColumns: ["id_conteo"]
          },
          {
            foreignKeyName: "conteo_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conteo_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      conteos_fisicos: {
        Row: {
          creado_en: string
          fecha_conteo: string
          id: string
          id_entidad: string
          notas: string | null
          status: string
          usuario_creador: string | null
        }
        Insert: {
          creado_en?: string
          fecha_conteo: string
          id?: string
          id_entidad: string
          notas?: string | null
          status?: string
          usuario_creador?: string | null
        }
        Update: {
          creado_en?: string
          fecha_conteo?: string
          id?: string
          id_entidad?: string
          notas?: string | null
          status?: string
          usuario_creador?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      cotizacion_detalles: {
        Row: {
          cantidad: number
          id: string
          id_cotizacion: string
          id_producto: string
          precio_unitario: number
        }
        Insert: {
          cantidad: number
          id?: string
          id_cotizacion: string
          id_producto: string
          precio_unitario: number
        }
        Update: {
          cantidad?: number
          id?: string
          id_cotizacion?: string
          id_producto?: string
          precio_unitario?: number
        }
        Relationships: [
          {
            foreignKeyName: "cotizacion_detalles_id_cotizacion_fkey"
            columns: ["id_cotizacion"]
            isOneToOne: false
            referencedRelation: "cotizaciones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizacion_detalles_id_cotizacion_fkey"
            columns: ["id_cotizacion"]
            isOneToOne: false
            referencedRelation: "v_cotizaciones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizacion_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizacion_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      cotizaciones: {
        Row: {
          creado_en: string
          estado: string
          fecha: string
          folio: string
          id: string
          id_comprador: string | null
          id_ticket: string | null
          id_vendedor: string
          nombre_prospecto: string | null
          notas: string | null
          total: number
          usuario_creador: string
          vigencia_dias: number
          vigente_hasta: string | null
          zona: string
        }
        Insert: {
          creado_en?: string
          estado?: string
          fecha?: string
          folio?: string
          id?: string
          id_comprador?: string | null
          id_ticket?: string | null
          id_vendedor: string
          nombre_prospecto?: string | null
          notas?: string | null
          total: number
          usuario_creador: string
          vigencia_dias?: number
          vigente_hasta?: string | null
          zona?: string
        }
        Update: {
          creado_en?: string
          estado?: string
          fecha?: string
          folio?: string
          id?: string
          id_comprador?: string | null
          id_ticket?: string | null
          id_vendedor?: string
          nombre_prospecto?: string | null
          notas?: string | null
          total?: number
          usuario_creador?: string
          vigencia_dias?: number
          vigente_hasta?: string | null
          zona?: string
        }
        Relationships: [
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_ticket_fkey"
            columns: ["id_ticket"]
            isOneToOne: false
            referencedRelation: "transacciones_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      cuentas_financieras: {
        Row: {
          id: string
          id_entidad: string | null
          nombre: string
          tipo_fiscalidad: string
        }
        Insert: {
          id?: string
          id_entidad?: string | null
          nombre: string
          tipo_fiscalidad: string
        }
        Update: {
          id?: string
          id_entidad?: string | null
          nombre?: string
          tipo_fiscalidad?: string
        }
        Relationships: [
          {
            foreignKeyName: "cuentas_financieras_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cuentas_financieras_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cuentas_financieras_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cuentas_financieras_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cuentas_financieras_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      entidades: {
        Row: {
          aplica_redondeo_costo: boolean | null
          auth_id: string | null
          comision_base: number | null
          comision_base_local: number | null
          comision_hijo_local: number | null
          comision_logistica: number | null
          email: string | null
          es_distribuidor: boolean | null
          fecha_ultimo_seguimiento: string | null
          id: string
          id_nodo_padre: string | null
          id_padre: string | null
          nombre: string
          rol: string
          telefono: string | null
          ubicacion_maps: string | null
          ultimo_seguimiento: string | null
          zona: string
        }
        Insert: {
          aplica_redondeo_costo?: boolean | null
          auth_id?: string | null
          comision_base?: number | null
          comision_base_local?: number | null
          comision_hijo_local?: number | null
          comision_logistica?: number | null
          email?: string | null
          es_distribuidor?: boolean | null
          fecha_ultimo_seguimiento?: string | null
          id?: string
          id_nodo_padre?: string | null
          id_padre?: string | null
          nombre: string
          rol: string
          telefono?: string | null
          ubicacion_maps?: string | null
          ultimo_seguimiento?: string | null
          zona: string
        }
        Update: {
          aplica_redondeo_costo?: boolean | null
          auth_id?: string | null
          comision_base?: number | null
          comision_base_local?: number | null
          comision_hijo_local?: number | null
          comision_logistica?: number | null
          email?: string | null
          es_distribuidor?: boolean | null
          fecha_ultimo_seguimiento?: string | null
          id?: string
          id_nodo_padre?: string | null
          id_padre?: string | null
          nombre?: string
          rol?: string
          telefono?: string | null
          ubicacion_maps?: string | null
          ultimo_seguimiento?: string | null
          zona?: string
        }
        Relationships: [
          {
            foreignKeyName: "entidades_id_nodo_padre_fkey"
            columns: ["id_nodo_padre"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entidades_id_nodo_padre_fkey"
            columns: ["id_nodo_padre"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "entidades_id_nodo_padre_fkey"
            columns: ["id_nodo_padre"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "entidades_id_nodo_padre_fkey"
            columns: ["id_nodo_padre"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "entidades_id_nodo_padre_fkey"
            columns: ["id_nodo_padre"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "entidades_id_padre_fkey"
            columns: ["id_padre"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entidades_id_padre_fkey"
            columns: ["id_padre"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "entidades_id_padre_fkey"
            columns: ["id_padre"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "entidades_id_padre_fkey"
            columns: ["id_padre"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "entidades_id_padre_fkey"
            columns: ["id_padre"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      finanzas_ledger: {
        Row: {
          categoria: string | null
          categoria_gasto: string | null
          descripcion: string | null
          es_recurrente: boolean | null
          fecha_movimiento: string | null
          id: string
          id_cuenta_destino: string | null
          id_cuenta_origen: string | null
          id_entidad_relacionada: string | null
          id_ticket: string | null
          metodo_pago: string | null
          monto: number
          status: string
          subcategoria: string | null
          tipo_movimiento: string
          usuario_creador: string | null
        }
        Insert: {
          categoria?: string | null
          categoria_gasto?: string | null
          descripcion?: string | null
          es_recurrente?: boolean | null
          fecha_movimiento?: string | null
          id?: string
          id_cuenta_destino?: string | null
          id_cuenta_origen?: string | null
          id_entidad_relacionada?: string | null
          id_ticket?: string | null
          metodo_pago?: string | null
          monto: number
          status?: string
          subcategoria?: string | null
          tipo_movimiento: string
          usuario_creador?: string | null
        }
        Update: {
          categoria?: string | null
          categoria_gasto?: string | null
          descripcion?: string | null
          es_recurrente?: boolean | null
          fecha_movimiento?: string | null
          id?: string
          id_cuenta_destino?: string | null
          id_cuenta_origen?: string | null
          id_entidad_relacionada?: string | null
          id_ticket?: string | null
          metodo_pago?: string | null
          monto?: number
          status?: string
          subcategoria?: string | null
          tipo_movimiento?: string
          usuario_creador?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finanzas_ledger_id_cuenta_destino_fkey"
            columns: ["id_cuenta_destino"]
            isOneToOne: false
            referencedRelation: "cuentas_financieras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_cuenta_origen_fkey"
            columns: ["id_cuenta_origen"]
            isOneToOne: false
            referencedRelation: "cuentas_financieras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_ticket_fkey"
            columns: ["id_ticket"]
            isOneToOne: false
            referencedRelation: "transacciones_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      inventario_ledger: {
        Row: {
          cantidad: number
          costo_unitario_movimiento: number | null
          cubeta: string
          fecha_movimiento: string | null
          id: string
          id_entidad_destino: string | null
          id_entidad_origen: string | null
          id_producto: string
          notas: string | null
          status: string
          tipo_movimiento: string
          usuario_creador: string | null
        }
        Insert: {
          cantidad: number
          costo_unitario_movimiento?: number | null
          cubeta?: string
          fecha_movimiento?: string | null
          id?: string
          id_entidad_destino?: string | null
          id_entidad_origen?: string | null
          id_producto: string
          notas?: string | null
          status?: string
          tipo_movimiento: string
          usuario_creador?: string | null
        }
        Update: {
          cantidad?: number
          costo_unitario_movimiento?: number | null
          cubeta?: string
          fecha_movimiento?: string | null
          id?: string
          id_entidad_destino?: string | null
          id_entidad_origen?: string | null
          id_producto?: string
          notas?: string | null
          status?: string
          tipo_movimiento?: string
          usuario_creador?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventario_ledger_id_entidad_destino_fkey"
            columns: ["id_entidad_destino"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_destino_fkey"
            columns: ["id_entidad_destino"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_destino_fkey"
            columns: ["id_entidad_destino"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_destino_fkey"
            columns: ["id_entidad_destino"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_destino_fkey"
            columns: ["id_entidad_destino"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_origen_fkey"
            columns: ["id_entidad_origen"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_origen_fkey"
            columns: ["id_entidad_origen"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_origen_fkey"
            columns: ["id_entidad_origen"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_origen_fkey"
            columns: ["id_entidad_origen"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_entidad_origen_fkey"
            columns: ["id_entidad_origen"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "inventario_ledger_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventario_ledger_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      listas_precios: {
        Row: {
          id: string
          id_producto: string | null
          precio_final: number
          zona: string
        }
        Insert: {
          id?: string
          id_producto?: string | null
          precio_final: number
          zona: string
        }
        Update: {
          id?: string
          id_producto?: string | null
          precio_final?: number
          zona?: string
        }
        Relationships: [
          {
            foreignKeyName: "listas_precios_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listas_precios_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      lote_entradas: {
        Row: {
          cantidad: number
          id: string
          id_insumo: string
          id_lote: string
        }
        Insert: {
          cantidad: number
          id?: string
          id_insumo: string
          id_lote: string
        }
        Update: {
          cantidad?: number
          id?: string
          id_insumo?: string
          id_lote?: string
        }
        Relationships: [
          {
            foreignKeyName: "lote_entradas_id_insumo_fkey"
            columns: ["id_insumo"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lote_entradas_id_insumo_fkey"
            columns: ["id_insumo"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
          {
            foreignKeyName: "lote_entradas_id_lote_fkey"
            columns: ["id_lote"]
            isOneToOne: false
            referencedRelation: "lotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lote_entradas_id_lote_fkey"
            columns: ["id_lote"]
            isOneToOne: false
            referencedRelation: "v_lote_rendimiento"
            referencedColumns: ["id"]
          },
        ]
      }
      lote_envasado: {
        Row: {
          botellas: number
          fecha: string
          id: string
          id_lote: string
          id_producto: string
        }
        Insert: {
          botellas: number
          fecha?: string
          id?: string
          id_lote: string
          id_producto: string
        }
        Update: {
          botellas?: number
          fecha?: string
          id?: string
          id_lote?: string
          id_producto?: string
        }
        Relationships: [
          {
            foreignKeyName: "lote_envasado_id_lote_fkey"
            columns: ["id_lote"]
            isOneToOne: false
            referencedRelation: "lotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lote_envasado_id_lote_fkey"
            columns: ["id_lote"]
            isOneToOne: false
            referencedRelation: "v_lote_rendimiento"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lote_envasado_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lote_envasado_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      lote_salidas: {
        Row: {
          grado_alcohol: number | null
          id: string
          id_lote: string
          litros: number
          notas: string | null
          numero_tanda: number
          peso_kg: number | null
        }
        Insert: {
          grado_alcohol?: number | null
          id?: string
          id_lote: string
          litros: number
          notas?: string | null
          numero_tanda: number
          peso_kg?: number | null
        }
        Update: {
          grado_alcohol?: number | null
          id?: string
          id_lote?: string
          litros?: number
          notas?: string | null
          numero_tanda?: number
          peso_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "lote_salidas_id_lote_fkey"
            columns: ["id_lote"]
            isOneToOne: false
            referencedRelation: "lotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lote_salidas_id_lote_fkey"
            columns: ["id_lote"]
            isOneToOne: false
            referencedRelation: "v_lote_rendimiento"
            referencedColumns: ["id"]
          },
        ]
      }
      lotes: {
        Row: {
          codigo_lote: string
          creado_en: string
          fecha_fin_fermentacion: string | null
          fecha_inicio: string
          horas_fermentacion: number | null
          id: string
          notas: string | null
          usuario_creador: string
        }
        Insert: {
          codigo_lote: string
          creado_en?: string
          fecha_fin_fermentacion?: string | null
          fecha_inicio: string
          horas_fermentacion?: number | null
          id?: string
          notas?: string | null
          usuario_creador: string
        }
        Update: {
          codigo_lote?: string
          creado_en?: string
          fecha_fin_fermentacion?: string | null
          fecha_inicio?: string
          horas_fermentacion?: number | null
          id?: string
          notas?: string | null
          usuario_creador?: string
        }
        Relationships: []
      }
      recetas_produccion: {
        Row: {
          cantidad_requerida: number
          id: string
          id_insumo: string | null
          id_producto_terminado: string | null
        }
        Insert: {
          cantidad_requerida: number
          id?: string
          id_insumo?: string | null
          id_producto_terminado?: string | null
        }
        Update: {
          cantidad_requerida?: number
          id?: string
          id_insumo?: string | null
          id_producto_terminado?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recetas_produccion_id_insumo_fkey"
            columns: ["id_insumo"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recetas_produccion_id_insumo_fkey"
            columns: ["id_insumo"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
          {
            foreignKeyName: "recetas_produccion_id_producto_terminado_fkey"
            columns: ["id_producto_terminado"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recetas_produccion_id_producto_terminado_fkey"
            columns: ["id_producto_terminado"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      ticket_detalles: {
        Row: {
          cantidad: number
          id: string
          id_producto: string | null
          id_ticket: string | null
          precio_unitario: number
          subtotal_linea: number
        }
        Insert: {
          cantidad: number
          id?: string
          id_producto?: string | null
          id_ticket?: string | null
          precio_unitario: number
          subtotal_linea: number
        }
        Update: {
          cantidad?: number
          id?: string
          id_producto?: string | null
          id_ticket?: string | null
          precio_unitario?: number
          subtotal_linea?: number
        }
        Relationships: [
          {
            foreignKeyName: "ticket_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
          {
            foreignKeyName: "ticket_detalles_id_ticket_fkey"
            columns: ["id_ticket"]
            isOneToOne: false
            referencedRelation: "transacciones_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      transacciones_tickets: {
        Row: {
          bonificacion_cascada_generada: number | null
          condicion_pago: string
          fecha_transaccion: string | null
          id: string
          id_comprador: string | null
          id_cuenta_destino: string | null
          id_vendedor: string | null
          impuesto_ieps_calculado: number | null
          impuesto_iva_calculado: number | null
          monto_base_ingreso: number
          status: string | null
          subtotal_catalogo: number
          total_cobrado_real: number
          usuario_creador: string | null
        }
        Insert: {
          bonificacion_cascada_generada?: number | null
          condicion_pago?: string
          fecha_transaccion?: string | null
          id?: string
          id_comprador?: string | null
          id_cuenta_destino?: string | null
          id_vendedor?: string | null
          impuesto_ieps_calculado?: number | null
          impuesto_iva_calculado?: number | null
          monto_base_ingreso: number
          status?: string | null
          subtotal_catalogo: number
          total_cobrado_real: number
          usuario_creador?: string | null
        }
        Update: {
          bonificacion_cascada_generada?: number | null
          condicion_pago?: string
          fecha_transaccion?: string | null
          id?: string
          id_comprador?: string | null
          id_cuenta_destino?: string | null
          id_vendedor?: string | null
          impuesto_ieps_calculado?: number | null
          impuesto_iva_calculado?: number | null
          monto_base_ingreso?: number
          status?: string | null
          subtotal_catalogo?: number
          total_cobrado_real?: number
          usuario_creador?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "transacciones_tickets_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_cuenta_destino_fkey"
            columns: ["id_cuenta_destino"]
            isOneToOne: false
            referencedRelation: "cuentas_financieras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "transacciones_tickets_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
    }
    Views: {
      v_cartera: {
        Row: {
          abonado: number | null
          calculado_en: string | null
          deuda: number | null
          dias_sin_abono: number | null
          estimado_en_piso: number | null
          generado: number | null
          id_entidad: string | null
          libro_dice: number | null
          nombre: string | null
          porcentaje_pagado: number | null
          prioridad: number | null
          recibidas: number | null
          referencia_dias: string | null
          rol: string | null
          salidas: number | null
          ultimo_abono: string | null
        }
        Relationships: []
      }
      v_conteo_ultimo: {
        Row: {
          cubeta: string | null
          diferencia: number | null
          fecha_conteo: string | null
          id_conteo: string | null
          id_entidad: string | null
          id_producto: string | null
          libro_decia: number | null
          piezas_contadas: number | null
          usuario_creador: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conteo_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conteo_detalles_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "conteos_fisicos_id_entidad_fkey"
            columns: ["id_entidad"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      v_costo_produccion: {
        Row: {
          costo_insumos: number | null
          costo_parcial_conocido: number | null
          faltan_costo: string | null
          id_producto_terminado: string | null
          insumos_en_receta: number | null
          insumos_sin_costo: number | null
          margen_bruto_antes_de_impuestos: number | null
          nombre: string | null
          precio_zacatecas: number | null
          receta_incluye_materia_prima: boolean | null
          sku: string | null
        }
        Relationships: []
      }
      v_cotizaciones: {
        Row: {
          creado_en: string | null
          dias_restantes: number | null
          estado: string | null
          estado_efectivo: string | null
          fecha: string | null
          folio: string | null
          id: string | null
          id_comprador: string | null
          id_ticket: string | null
          id_vendedor: string | null
          nombre_prospecto: string | null
          notas: string | null
          para_quien: string | null
          total: number | null
          usuario_creador: string | null
          vigencia_dias: number | null
          vigente_hasta: string | null
          zona: string | null
        }
        Insert: {
          creado_en?: string | null
          dias_restantes?: never
          estado?: string | null
          estado_efectivo?: never
          fecha?: string | null
          folio?: string | null
          id?: string | null
          id_comprador?: string | null
          id_ticket?: string | null
          id_vendedor?: string | null
          nombre_prospecto?: string | null
          notas?: string | null
          para_quien?: never
          total?: number | null
          usuario_creador?: string | null
          vigencia_dias?: number | null
          vigente_hasta?: string | null
          zona?: string | null
        }
        Update: {
          creado_en?: string | null
          dias_restantes?: never
          estado?: string | null
          estado_efectivo?: never
          fecha?: string | null
          folio?: string | null
          id?: string | null
          id_comprador?: string | null
          id_ticket?: string | null
          id_vendedor?: string | null
          nombre_prospecto?: string | null
          notas?: string | null
          para_quien?: never
          total?: number | null
          usuario_creador?: string | null
          vigencia_dias?: number | null
          vigente_hasta?: string | null
          zona?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_comprador_fkey"
            columns: ["id_comprador"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_ticket_fkey"
            columns: ["id_ticket"]
            isOneToOne: false
            referencedRelation: "transacciones_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "cotizaciones_id_vendedor_fkey"
            columns: ["id_vendedor"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
        ]
      }
      v_insumos_en_negativo: {
        Row: {
          capturado_entradas: number | null
          consumido: number | null
          entidad: string | null
          faltante: number | null
          id_entidad: string | null
          id_producto: string | null
          insumo: string | null
          sku: string | null
          stock: number | null
          unidad_medida: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventario_ledger_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventario_ledger_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      v_lote_rendimiento: {
        Row: {
          alcanza_el_grado_diluyendo: boolean | null
          alcohol_absoluto_l: number | null
          botellas: number | null
          botellas_750_teoricas: number | null
          codigo_lote: string | null
          costo_insumos_conocido: number | null
          costo_por_ml: number | null
          costo_por_ml_al_grado_objetivo: number | null
          faltan_costo: string | null
          fecha_fin_fermentacion: string | null
          fecha_inicio: string | null
          grado_objetivo: number | null
          grado_ponderado: number | null
          horas_fermentacion: number | null
          id: string | null
          insumos_sin_costo: number | null
          kg_chile: number | null
          litros_al_grado_objetivo: number | null
          litros_por_kg_chile: number | null
          litros_producidos: number | null
          merma_envasado: number | null
          ml_envasados: number | null
          tandas: number | null
          tandas_sin_grado: number | null
        }
        Relationships: []
      }
      v_movimiento_clasificado: {
        Row: {
          categoria: string | null
          categoria_gasto: string | null
          descripcion: string | null
          es_contable_efectivo: boolean | null
          es_egreso_admin: boolean | null
          es_ingreso_admin: boolean | null
          fecha_movimiento: string | null
          id: string | null
          id_cuenta_destino: string | null
          id_cuenta_origen: string | null
          id_entidad_relacionada: string | null
          id_ticket: string | null
          monto: number | null
          status: string | null
          tipo_movimiento: string | null
          toca_cuenta_admin: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "finanzas_ledger_id_cuenta_destino_fkey"
            columns: ["id_cuenta_destino"]
            isOneToOne: false
            referencedRelation: "cuentas_financieras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_cuenta_origen_fkey"
            columns: ["id_cuenta_origen"]
            isOneToOne: false
            referencedRelation: "cuentas_financieras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_cartera"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_insumos_en_negativo"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_saldo_entidad"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_entidad_relacionada_fkey"
            columns: ["id_entidad_relacionada"]
            isOneToOne: false
            referencedRelation: "v_stock_por_cubeta"
            referencedColumns: ["id_entidad"]
          },
          {
            foreignKeyName: "finanzas_ledger_id_ticket_fkey"
            columns: ["id_ticket"]
            isOneToOne: false
            referencedRelation: "transacciones_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      v_pasivo_fiscal: {
        Row: {
          calculado_en: string | null
          ieps_por_pagar: number | null
          iva_por_pagar: number | null
          pagos_ieps: number | null
          pagos_iva: number | null
          pasivo_ieps_acumulado: number | null
          pasivo_iva_acumulado: number | null
        }
        Relationships: []
      }
      v_resumen_del_dia: {
        Row: {
          abonos: number | null
          abonos_monto: number | null
          avisos_pendientes: number | null
          fecha: string | null
          gastos: number | null
          gastos_monto: number | null
          lotes: number | null
          movimientos_del_dia: number | null
          ventas: number | null
          ventas_monto: number | null
        }
        Relationships: []
      }
      v_saldo_entidad: {
        Row: {
          abonos_aprobados: number | null
          calculado_en: string | null
          cargos_deuda: number | null
          deuda_generada_tickets: number | null
          dias_sin_abonar: number | null
          id_entidad: string | null
          nombre: string | null
          rol: string | null
          saldo_pendiente_consignacion: number | null
          saldo_por_pagar_efectivo: number | null
          total_ganado_comisiones: number | null
          ultimo_abono: string | null
        }
        Relationships: []
      }
      v_stock_por_cubeta: {
        Row: {
          cubeta: string | null
          entidad: string | null
          id_entidad: string | null
          id_producto: string | null
          producto: string | null
          stock: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventario_ledger_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventario_ledger_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "v_costo_produccion"
            referencedColumns: ["id_producto_terminado"]
          },
        ]
      }
      v_ventas_por_mes: {
        Row: {
          compradores: number | null
          mes: string | null
          tickets: number | null
          tickets_concesion: number | null
          vendido: number | null
          vendido_concesion: number | null
          vendido_contado: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      anular_ticket_atomica: {
        Args: {
          p_ticket_id: string
        }
        Returns: Json
      }
      crear_entidad_atomica: {
        Args: {
          p_cuenta: Json
          p_entidad: Json
        }
        Returns: string
      }
      entidad_pendiente_de_asignar: { Args: never; Returns: string }
      mi_entidad_id: { Args: never; Returns: string }
      mi_rol: { Args: never; Returns: string }
      migraciones_aplicadas: {
        Args: never
        Returns: {
          name: string
          version: string
        }[]
      }
      mis_entidades: { Args: never; Returns: string[] }
      movimientos_de_envasado: {
        Args: {
          p_botellas: number
          p_id_producto: string
        }
        Returns: {
          cantidad: number
          id_producto: string
          tipo_movimiento: string
        }[]
      }
      registrar_en_lote: {
        Args: {
          p_entradas: Json
          p_envasado: Json
          p_id_lote: string
          p_tandas: Json
          p_usuario: string
        }
        Returns: Json
      }
      registrar_venta_atomica: {
        Args: {
          p_detalles: Json
          p_finanzas?: Json
          p_inventario?: Json
          p_ticket: Json
        }
        Returns: string
      }
      usuario_de_sesion: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
