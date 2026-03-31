declare module "winreg" {
  type RegistryArch = "x86" | "x64"

  interface RegistryItem {
    value?: string
  }

  interface RegistryError extends Error {
    code?: number | string
  }

  class Registry {
    constructor(options: { hive: string; key: string; arch?: RegistryArch })

    get(
      name: string,
      callback: (
        error: RegistryError | null,
        item: RegistryItem | null,
      ) => void,
    ): void

    set(
      name: string,
      type: string,
      value: string,
      callback: (error: RegistryError | null) => void,
    ): void

    static HKCU: string
    static REG_SZ: string
  }

  export = Registry
}
