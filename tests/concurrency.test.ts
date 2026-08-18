import assert from 'node:assert/strict'
import test from 'node:test'

import { createConcurrencyLimiter, retryAsync } from '../src/concurrency.ts'

test('POS-31 native CLI fan-out never exceeds eight concurrent jobs', async () => {
  const limit = createConcurrencyLimiter(8)
  let active = 0
  let peak = 0
  let release: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => { release = resolve })

  const jobs = Array.from({ length: 40 }, (_, index) => limit(async () => {
    active++
    peak = Math.max(peak, active)
    await barrier
    // Vary completion order after the simultaneous release to exercise slot
    // hand-off while new work is queued.
    await new Promise((resolve) => setTimeout(resolve, index % 3))
    active--
  }))

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(active, 8)
  release?.()
  await Promise.all(jobs)
  assert.equal(peak, 8)
})

test('POS-32 queued CLI jobs all run after earlier jobs release their slots', async () => {
  const limit = createConcurrencyLimiter(2)
  const completed: number[] = []
  await Promise.all(Array.from({ length: 12 }, (_, index) => limit(async () => {
    await new Promise((resolve) => setTimeout(resolve, index % 2))
    completed.push(index)
  })))
  assert.deepEqual([...completed].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index))
})

test('NEG-32 zero concurrency is rejected instead of deadlocking every job', () => {
  assert.throws(() => createConcurrencyLimiter(0), /positive integer/)
})

test('NEG-33 a failed CLI job releases its slot for the next queued job', async () => {
  const limit = createConcurrencyLimiter(1)
  const failed = limit(async () => { throw new Error('simulated CLI failure') })
  const recovered = limit(async () => 'next job ran')
  await assert.rejects(failed, /simulated CLI failure/)
  assert.equal(await recovered, 'next job ran')
})

test('POS-35 a single-slot limiter serializes native CLI jobs', async () => {
  const limit = createConcurrencyLimiter(1)
  let active = 0
  let peak = 0
  await Promise.all(Array.from({ length: 10 }, () => limit(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active--
  })))
  assert.equal(peak, 1)
})

test('POS-36 queued jobs start in FIFO order', async () => {
  const limit = createConcurrencyLimiter(1)
  const started: number[] = []
  await Promise.all(Array.from({ length: 8 }, (_, index) => limit(async () => {
    started.push(index)
  })))
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7])
})

test('POS-37 limiter preserves each task return value', async () => {
  const limit = createConcurrencyLimiter(3)
  const values = await Promise.all([1, 2, 3, 4].map((value) => limit(async () => value * 10)))
  assert.deepEqual(values, [10, 20, 30, 40])
})

test('NEG-42 fractional concurrency is rejected', () => {
  assert.throws(() => createConcurrencyLimiter(1.5), /positive integer/)
})

test('NEG-43 NaN concurrency is rejected', () => {
  assert.throws(() => createConcurrencyLimiter(Number.NaN), /positive integer/)
})

test('NEG-44 infinite concurrency is rejected', () => {
  assert.throws(() => createConcurrencyLimiter(Number.POSITIVE_INFINITY), /positive integer/)
})

test('POS-52 transient native CLI failure is recovered by a later attempt', async () => {
  let attempts = 0
  const value = await retryAsync(async () => {
    attempts++
    if (attempts < 3) throw new Error('transient exit 1')
    return 'skill content'
  }, 3, 0)
  assert.equal(value, 'skill content')
  assert.equal(attempts, 3)
})

test('NEG-52 persistent native CLI failure surfaces after the retry budget', async () => {
  let attempts = 0
  await assert.rejects(retryAsync(async () => {
    attempts++
    throw new Error('persistent exit 1')
  }, 3, 0), /persistent exit 1/)
  assert.equal(attempts, 3)
})
