// Caller identity. Teleport app access injects a signed JWT on every request
// (header Teleport-Jwt-Assertion). Claims: username, roles, traits; iss is the
// cluster name; aud is the app URI. Verified against the proxy's JWKS.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface Caller {
  username: string;
  roles: string[];
}

export class CallerVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    proxyHost: string,
    private readonly clusterName: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(`https://${proxyHost}/.well-known/jwks.json`));
  }

  async verify(token: string | undefined): Promise<Caller> {
    if (!token) throw new Error("missing Teleport-Jwt-Assertion header");
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.clusterName });
    return fromClaims(payload);
  }
}

function fromClaims(p: JWTPayload): Caller {
  const username = (p as any).username ?? p.sub;
  if (typeof username !== "string" || !username) throw new Error("JWT has no username");
  const roles = Array.isArray((p as any).roles) ? ((p as any).roles as string[]) : [];
  return { username, roles };
}

/** Dev mode: trust an X-Debug-Caller header instead of a JWT. Never in a beam. */
export class InsecureHeaderVerifier {
  async verify(header: string | undefined): Promise<Caller> {
    if (!header) throw new Error("missing X-Debug-Caller header (insecure dev mode)");
    return { username: header, roles: [] };
  }
}
