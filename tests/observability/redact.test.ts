import { expect, test } from "bun:test"

import {
  redactHeaders,
  redactText,
  redactUnknown,
} from "../../src/lib/observability/redact"

test("redactUnknown redacts sensitive keys recursively", () => {
  const value = {
    accessToken: "secret-token",
    nested: {
      password: "hunter2",
      okay: "keep-me",
    },
    list: [
      {
        authorization: "Bearer abc123",
      },
    ],
  }

  expect(redactUnknown(value)).toEqual({
    accessToken: "[REDACTED]",
    nested: {
      password: "[REDACTED]",
      okay: "keep-me",
    },
    list: [
      {
        authorization: "[REDACTED]",
      },
    ],
  })
})

test("redactText redacts bearer tokens and inline secrets", () => {
  const value = [
    "Authorization: Bearer abc123",
    "api_key=shh-secret",
    "password: hunter2",
  ].join("\n")

  expect(redactText(value)).toBe(
    [
      "Authorization: Bearer [REDACTED]",
      "api_key=[REDACTED]",
      "password: [REDACTED]",
    ].join("\n"),
  )
})

test("redactHeaders redacts sensitive header values", () => {
  expect(
    redactHeaders({
      authorization: "Bearer abc123",
      "x-api-key": "key-123",
      "content-type": "application/json",
    }),
  ).toEqual({
    authorization: "[REDACTED]",
    "x-api-key": "[REDACTED]",
    "content-type": "application/json",
  })
})
