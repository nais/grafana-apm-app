/** Extract unique environment values from a service list as Combobox options. */
export function extractEnvironmentOptions(
  services: Array<{ environment?: string }>
): Array<{ label: string; value: string }> {
  const envs = new Set(services.map((s) => s.environment).filter((e): e is string => !!e));
  return [...envs].sort().map((e) => ({ label: e, value: e }));
}

/** Extract unique namespace values from a service list as Combobox options. */
export function extractNamespaceOptions(
  services: Array<{ namespace: string }>
): Array<{ label: string; value: string }> {
  const nss = new Set(services.map((s) => s.namespace).filter(Boolean));
  return [...nss].sort().map((ns) => ({ label: ns, value: ns }));
}
