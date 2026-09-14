import { test, expect } from "@playwright/test"
import { comisionBaseLocalDecimal } from "../lib/comision-base-local"

test.describe("comisionBaseLocalDecimal: un solo default para toda la columna", () => {
  test("null y undefined dan 0 -conservador, no regala comision-", () => {
    expect(comisionBaseLocalDecimal(null)).toBe(0)
    expect(comisionBaseLocalDecimal(undefined)).toBe(0)
  })

  test("0 se queda en 0, no cae en el default por ser falsy", () => {
    expect(comisionBaseLocalDecimal(0)).toBe(0)
  })

  test("decimales de produccion pasan intactos", () => {
    expect(comisionBaseLocalDecimal(0.15)).toBe(0.15)
    expect(comisionBaseLocalDecimal(0.2)).toBe(0.2)
    expect(comisionBaseLocalDecimal(0.3)).toBe(0.3)
  })

  test("un entero de porcentaje se normaliza -legado de auditoria.ts:307-", () => {
    expect(comisionBaseLocalDecimal(15)).toBe(0.15)
    expect(comisionBaseLocalDecimal(20)).toBe(0.2)
  })
})
