import type { RomDefinition } from './parseDefinitionXml';

export interface RomIdentity {
  /** Hex string read out of the ROM at the definition's internalidaddress. */
  found: string;
  expected: string;
  matches: boolean;
  sizeBytes: number;
  message: string;
}

/**
 * Confirm a definition actually describes the loaded binary.
 *
 * Applying the wrong XML to a ROM produces tables full of plausible-looking
 * nonsense at the wrong addresses, so the app refuses to show tables until this
 * passes.
 */
export function identifyRom(rom: Uint8Array, def: RomDefinition): RomIdentity {
  const expected = (def.romid.internalidhex ?? '').trim();
  const addr = def.romid.internalidaddress;

  if (!Number.isFinite(addr)) {
    return {
      found: '',
      expected,
      matches: false,
      sizeBytes: rom.byteLength,
      message: 'definition has no <internalidaddress>, so the ROM cannot be verified',
    };
  }

  // The ID is stored as ASCII digits in Mitsubishi CAN images; compare on the
  // hex-encoded bytes so either representation lines up with internalidhex.
  const byteCount = Math.max(1, Math.ceil(expected.length / 2));
  if (addr + byteCount > rom.byteLength) {
    return {
      found: '',
      expected,
      matches: false,
      sizeBytes: rom.byteLength,
      message: `definition points at 0x${addr.toString(16)}, past the end of a ${rom.byteLength}-byte image`,
    };
  }

  let found = '';
  for (let i = 0; i < byteCount; i++) {
    found += rom[addr + i].toString(16).padStart(2, '0');
  }

  const matches = found.toLowerCase() === expected.toLowerCase();
  return {
    found: found.toUpperCase(),
    expected: expected.toUpperCase(),
    matches,
    sizeBytes: rom.byteLength,
    message: matches
      ? `ROM ID ${found.toUpperCase()} matches ${def.romid.make} ${def.romid.model} ${def.romid.submodel} (${def.romid.year}, ${def.romid.transmission})`
      : `ROM ID mismatch: image has ${found.toUpperCase()} at 0x${addr.toString(16)}, definition expects ${expected.toUpperCase()}`,
  };
}
