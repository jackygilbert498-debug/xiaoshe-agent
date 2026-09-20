import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseTrustedDohResponse } from '../src/trusted-doh.ts'

test('trusted DoH parsing accepts only the requested question and valid A or AAAA answers', () => {
  const ipv4 = parseTrustedDohResponse('example.com', 1, JSON.stringify({
    Status: 0,
    Question: [{ name: 'example.com.', type: 1 }],
    Answer: [
      { name: 'edge.example.net.', type: 1, data: '93.184.216.34' },
      { name: 'example.com.', type: 5, data: 'edge.example.net.' },
      { name: 'edge.example.net.', type: 1, data: '93.184.216.34' },
      { name: 'edge.example.net.', type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' },
    ],
  }))
  assert.deepEqual(ipv4, [{ address: '93.184.216.34', family: 4 }])

  const ipv6 = parseTrustedDohResponse('example.com', 28, JSON.stringify({
    Status: 0,
    Question: [{ name: 'EXAMPLE.COM', type: 28 }],
    Answer: [{ name: 'example.com.', type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }],
  }))
  assert.deepEqual(ipv6, [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }])
})

test('trusted DoH parsing rejects failed, mismatched, malformed, or oversized replies', () => {
  const validQuestion = [{ name: 'example.com.', type: 1 }]
  const invalidPayloads = [
    '{',
    JSON.stringify({ Status: 3, Question: validQuestion }),
    JSON.stringify({ Status: 0, Question: [{ name: 'attacker.example.', type: 1 }] }),
    JSON.stringify({ Status: 0, Question: [{ name: 'example.com.', type: 28 }] }),
    JSON.stringify({ Status: 0, Question: validQuestion, Answer: [{ type: 1, data: 'not-an-ip' }] }),
    JSON.stringify({
      Status: 0,
      Question: validQuestion,
      Answer: [{ name: 'attacker.example.', type: 1, data: '93.184.216.34' }],
    }),
    JSON.stringify({
      Status: 0,
      Question: validQuestion,
      Answer: Array.from({ length: 65 }, (_, index) => ({ type: 1, data: `8.8.${Math.floor(index / 256)}.${index % 256}` })),
    }),
  ]
  for (const payload of invalidPayloads) {
    assert.throws(() => parseTrustedDohResponse('example.com', 1, payload))
  }
})
