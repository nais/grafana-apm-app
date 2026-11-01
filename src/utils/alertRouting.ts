export function hasAlertRoutingContext(namespace: string, environment?: string): boolean {
  return Boolean(namespace && namespace !== '_' && environment?.trim() && !environment.includes(','));
}
