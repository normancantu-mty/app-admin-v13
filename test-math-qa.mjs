import { calculateFiscalLeak } from './lib/finance-utils.js'

// Casos de prueba para CUENTA_FRESNILLO
const testFresnillo = () => {
  const result = calculateFiscalLeak(1000, 'CUENTA_FRESNILLO')
  const expected = {
    montoBase: 563.38,
    ieps: 298.59,
    iva: 137.92,
    gastoOperativo: 0
  }

  Object.entries(expected).forEach(([key, val]) => {
    if (Math.abs(result[key] - val) > 0.01) {
      console.error(`❌ Test CUENTA_FRESNILLO falló en ${key}: Esperado ${val}, Obtenido ${result[key]}`)
      process.exit(1)
    }
  })
  console.log('✅ CUENTA_FRESNILLO: Test pasado')
}

// Casos de prueba para EFECTIVO
const testEfectivo = () => {
  const result = calculateFiscalLeak(1000, 'EFECTIVO')
  if (result.gastoOperativo !== 160 || result.iva !== 0) {
    console.error('❌ Test EFECTIVO falló')
    process.exit(1)
  }
  console.log('✅ EFECTIVO: Test pasado')
}

testFresnillo()
testEfectivo()
