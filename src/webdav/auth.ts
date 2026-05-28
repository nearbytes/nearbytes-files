export interface VolumeCredentials {
  readonly volumeName: string;
  readonly secret: string;
}

export function parseBasicAuth(
  header: string | undefined,
): { username: string; password: string } | null {
  if (header === undefined || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export function volumeSecret(volumeName: string, password: string): string {
  return `${volumeName}:${password}`;
}

export function credentialsFromRequest(
  volumeSegment: string,
  authHeader: string | undefined,
): VolumeCredentials | null {
  const basic = parseBasicAuth(authHeader);
  if (basic === null) return null;
  if (basic.username !== volumeSegment) return null;
  return { volumeName: volumeSegment, secret: volumeSecret(volumeSegment, basic.password) };
}
