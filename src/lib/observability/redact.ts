const REDACTED = "[REDACTED]"

const SENSITIVE_KEY_PATTERN =
  /(?:^|[._-])(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|session[_-]?id|cookie|set-cookie)(?:$|[._-])/i

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "cookie",
  "set-cookie",
])

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  return Object.getPrototypeOf(value) === Object.prototype
}

const redactInlineSecret = (key: string, value: string): string => {
  if (key.toLowerCase().includes("authorization")) {
    return value.replace(
      /\bBearer\s+[A-Za-z0-9\-._~+/=]+\b/gi,
      "Bearer " + REDACTED,
    )
  }

  return value
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|session[_-]?id|cookie)\b(\s*[:=]\s*)([^\s"'`,;]+)/gi,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/=]+\b/gi, "Bearer " + REDACTED)
}

export function redactText(value: string): string {
  return redactInlineSecret("", value)
}

export function redactHeaders(
  headers: Record<string, string | null | undefined>,
): Record<string, string | null | undefined> {
  const redacted: Record<string, string | null | undefined> = {}

  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined) {
      redacted[name] = value
      continue
    }

    redacted[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase())
      ? REDACTED
      : redactInlineSecret(name, value)
  }

  return redacted
}

export function redactUnknown<T>(value: T): T {
  if (typeof value === "string") {
    return redactText(value) as T
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry)) as T
  }

  if (!isPlainObject(value)) {
    return value
  }

  const result: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = REDACTED
      continue
    }

    result[key] = redactUnknown(entry)
  }

  return result as T
}

export { REDACTED }
