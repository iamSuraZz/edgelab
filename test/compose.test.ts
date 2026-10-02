import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two production compose files must not drift (A70).
 *
 * `docker-compose.prod.yml` is the portable one — it runs locally, which is what the backup restore
 * check depends on. `docker-compose.coolify.yml` is the one Coolify deploys, and it has to differ in
 * three specific ways (Coolify's `exclude_from_hc`, its generated Traefik labels, its managed volume
 * names). Everything else being the same is the point: a deployment file that has quietly forked from
 * the verified one is a production stack nobody has tested.
 *
 * Parsed with a deliberately small line reader rather than a YAML dependency. These assertions are
 * about literal text — an image tag, an environment KEY — and adding a parser to the root package to
 * check two files would be a worse trade than reading them.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

/** `image: redis:7.4.2-alpine` -> `redis:7.4.2-alpine`, for every service that pins one. */
function images(yaml: string): string[] {
  return (
    [...yaml.matchAll(/^\s+image:\s*(\S+)\s*$/gm)]
      .map((m) => m[1]!)
      // The app images carry a `${EDGELAB_VERSION}` tag in the portable file and are built by Coolify
      // in the other, so only third-party images are comparable.
      .filter((image) => !image.startsWith('edgelab-'))
      .sort()
  );
}

/** Environment KEYS per service. Values differ (ports, URLs); the keys are the contract. */
function envKeys(yaml: string): string[] {
  const keys = new Set<string>();
  for (const match of yaml.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):/gm)) keys.add(match[1]!);
  return [...keys].sort();
}

/**
 * Service names, from the `services:` block ONLY.
 *
 * Scoped deliberately: a two-space-indented key also matches the entries under `volumes:` and
 * `networks:`, so the first version of this reported `internal` and `proxy` as missing services.
 */
function serviceNames(yaml: string): string[] {
  const match = /^services:$/m.exec(yaml);
  if (match === null) return [];

  const rest = yaml.slice(match.index + match[0].length);
  // The block ends at the next top-level key (`volumes:`, `networks:`, or a comment column).
  const end = rest.search(/^[a-z]/m);
  const block = end === -1 ? rest : rest.slice(0, end);

  return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!).sort();
}

const prod = read('docker-compose.prod.yml');
const coolify = read('docker-compose.coolify.yml');

describe('production compose files agree', () => {
  it('pins the same third-party images, to the same patch', () => {
    // A pin that drifts between the two means the stack you tested is not the stack you deployed.
    expect(images(coolify)).toEqual(images(prod));
  });

  it('pins every third-party image, with no floating tags', () => {
    for (const image of images(prod)) {
      expect(image, `${image} is not pinned`).not.toMatch(/:latest$/);
      // A patch-level pin: `redis:7-alpine` would still float.
      expect(image, `${image} needs a patch-level tag`).toMatch(/:\d+\.\d+/);
    }
  });

  it('sets the same environment keys on both', () => {
    const prodOnly = envKeys(prod).filter((k) => !envKeys(coolify).includes(k));
    const coolifyOnly = envKeys(coolify).filter((k) => !envKeys(prod).includes(k));

    // `SERVICE_FQDN_WEB_8080` is Coolify's magic variable and has no equivalent in a hand-rolled
    // Traefik setup, where the domain arrives through a router label instead.
    expect(coolifyOnly).toEqual(['SERVICE_FQDN_WEB_8080']);
    expect(prodOnly).toEqual([]);
  });

  it('declares the same services', () => {
    expect(serviceNames(coolify)).toEqual(serviceNames(prod));
  });

  it('keeps the migrate gate on both api and worker', () => {
    // The whole point of the one-shot migrate service: losing this on one file would leave a
    // deployment booting against an empty schema.
    for (const [label, yaml] of [
      ['prod', prod],
      ['coolify', coolify],
    ] as const) {
      const gates = [...yaml.matchAll(/condition:\s*service_completed_successfully/g)];
      expect(gates.length, `${label} should gate both api and worker on migrate`).toBe(2);
    }
  });

  it('publishes no ports in either production file', () => {
    // Everything arrives through the proxy. `docker-compose.restore-check.yml` is the one override
    // that publishes a port, and it exists so that port is in a file you have to opt into.
    expect(prod).not.toMatch(/^\s+ports:/m);
    expect(coolify).not.toMatch(/^\s+ports:/m);
  });

  it('gives a domain to the web service only', () => {
    // An FQDN on the API would publish an unauthenticated API beside the authenticated UI.
    const fqdnLines = [...coolify.matchAll(/^\s+SERVICE_FQDN_\w+:/gm)].map((m) => m[0]!.trim());
    expect(fqdnLines).toEqual(['SERVICE_FQDN_WEB_8080:']);
  });

  it('does not carry hand-written Traefik router labels in the Coolify file', () => {
    // Coolify generates them from the domain set in its UI; duplicating them is how a router ends up
    // defined twice with different rules.
    expect(coolify).not.toMatch(/traefik\.http\.routers/);
  });
});
