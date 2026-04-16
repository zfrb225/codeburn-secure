import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir, tmpdir } from 'os'

import { readConfig } from './config.js'

type CurrencyState = {
  code: string
  rate: number
  symbol: string
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD&to='

let active: CurrencyState = { code: 'USD', rate: 1, symbol: '$' }

const USD: CurrencyState = { code: 'USD', rate: 1, symbol: '$' }

// Intl.NumberFormat throws on invalid ISO 4217 codes, so we use it as a validator
export function isValidCurrencyCode(code: string): boolean {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code })
    return true
  } catch {
    return false
  }
}

function resolveSymbol(code: string): string {
  const parts = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'symbol',
  }).formatToParts(0)
  return parts.find(p => p.type === 'currency')?.value ?? code
}

function getFractionDigits(code: string): number {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
  }).resolvedOptions().maximumFractionDigits ?? 2
}

function getCacheDir(): string {
  return join(homedir(), '.cache', 'codeburn')
}

function getRateCachePath(): string {
  return join(getCacheDir(), 'exchange-rate.json')
}

async function fetchRate(code: string): Promise<number> {
  const response = await fetch(`${FRANKFURTER_URL}${code}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json() as { rates: Record<string, number> }
  const rate = data.rates[code]
  if (!rate) throw new Error(`No rate returned for ${code}`)
  return rate
}

async function loadCachedRate(code: string): Promise<number | null> {
  try {
    const raw = await readFile(getRateCachePath(), 'utf-8')
    const cached = JSON.parse(raw) as { timestamp: number; code: string; rate: number }
    if (cached.code !== code) return null
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
    return cached.rate
  } catch {
    return null
  }
}

async function cacheRate(code: string, rate: number): Promise<void> {
  await mkdir(getCacheDir(), { recursive: true })
  const tmpPath = join(tmpdir(), `codeburn-${Date.now()}.tmp`)
  await writeFile(tmpPath, JSON.stringify({ timestamp: Date.now(), code, rate }))
  await rename(tmpPath, getRateCachePath())
}

async function getExchangeRate(code: string): Promise<number> {
  if (code === 'USD') return 1

  const cached = await loadCachedRate(code)
  if (cached) return cached

  try {
    const rate = await fetchRate(code)
    await cacheRate(code, rate)
    return rate
  } catch {
    return 1
  }
}

export async function loadCurrency(): Promise<void> {
  const config = await readConfig()
  if (!config.currency) return

  const code = config.currency.code.toUpperCase()
  // config file values are not validated by the CLI's isValidCurrencyCode check,
  // so we must validate here before using the code in a URL or Intl API call.
  if (!isValidCurrencyCode(code)) return

  const rate = await getExchangeRate(code)
  const symbol = config.currency.symbol ?? resolveSymbol(code)

  active = { code, rate, symbol }
}

export function getCurrency(): CurrencyState {
  return active
}

export async function switchCurrency(code: string): Promise<void> {
  if (code === 'USD') {
    active = USD
    return
  }
  const rate = await getExchangeRate(code)
  const symbol = resolveSymbol(code)
  active = { code, rate, symbol }
}

export function getCostColumnHeader(): string {
  return `Cost (${active.code})`
}

export function convertCost(costUSD: number): number {
  const digits = getFractionDigits(active.code)
  const factor = 10 ** digits
  return Math.round(costUSD * active.rate * factor) / factor
}

export function formatCost(costUSD: number): string {
  const { rate, symbol, code } = active
  const cost = costUSD * rate
  const digits = getFractionDigits(code)

  if (digits === 0) return `${symbol}${Math.round(cost)}`

  if (cost >= 1) return `${symbol}${cost.toFixed(2)}`
  if (cost >= 0.01) return `${symbol}${cost.toFixed(3)}`
  return `${symbol}${cost.toFixed(4)}`
}
