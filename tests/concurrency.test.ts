import assert from 'node:assert/strict'
import test from 'node:test'

import { createConcurrencyLimiter } from '../src/concurrency.ts'

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
