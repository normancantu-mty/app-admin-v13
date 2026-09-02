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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      catalogo_productos: {
        Row: {
          costo_unitario: number | null
          id: string
          nombre: string
          sku: string
          tipo: string
          unidad_medida: string | null
        }
        Insert: {
          costo_unitario?: number | null
          id?: string
          nombre: string
          sku: string
          tipo: string
          unidad_medida?: string | null
        }
        Update: {
          costo_unitario?: number | null
          id?: string
          nombre?: string
          sku?: string
          tipo?: string
          unidad_medida?: string | null
        }
        Relationships: []
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
            foreignKeyName: "entidades_id_padre_fkey"
            columns: ["id_padre"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
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
          tipo_movimiento: string | null
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
          tipo_movimiento?: string | null
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
          tipo_movimiento?: string | null
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
          status: string | null
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
          status?: string | null
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
          status?: string | null
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
            foreignKeyName: "inventario_ledger_id_entidad_origen_fkey"
            columns: ["id_entidad_origen"]
            isOneToOne: false
            referencedRelation: "entidades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventario_ledger_id_producto_fkey"
            columns: ["id_producto"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
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
        ]
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
            foreignKeyName: "recetas_produccion_id_producto_terminado_fkey"
            columns: ["id_producto_terminado"]
            isOneToOne: false
            referencedRelation: "catalogo_productos"
            referencedColumns: ["id"]
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
          status: string
          id_comprador: string | null
          id_cuenta_destino: string | null
          id_vendedor: string | null
          impuesto_ieps_calculado: number | null
          impuesto_iva_calculado: number | null
          monto_base_ingreso: number
          subtotal_catalogo: number
          total_cobrado_real: number
          usuario_creador: string | null
        }
        Insert: {
          bonificacion_cascada_generada?: number | null
          condicion_pago?: string
          fecha_transaccion?: string | null
          id?: string
          status?: string
          id_comprador?: string | null
          id_cuenta_destino?: string | null
          id_vendedor?: string | null
          impuesto_ieps_calculado?: number | null
          impuesto_iva_calculado?: number | null
          monto_base_ingreso: number
          subtotal_catalogo: number
          total_cobrado_real: number
          usuario_creador?: string | null
        }
        Update: {
          bonificacion_cascada_generada?: number | null
          condicion_pago?: string
          fecha_transaccion?: string | null
          id?: string
          status?: string
          id_comprador?: string | null
          id_cuenta_destino?: string | null
          id_vendedor?: string | null
          impuesto_ieps_calculado?: number | null
          impuesto_iva_calculado?: number | null
          monto_base_ingreso?: number
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
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      mis_entidades: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      registrar_logistica_inversa: {
        Args: {
          p_cantidad: number
          p_distribuidor_id?: string
          p_monto_abono?: number
          p_producto_id: string
          p_tipo_movimiento: string
          p_usuario_creador?: string
          p_usuario_id: string
        }
        Returns: undefined
      }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
