# Independent minimal-proxy fixtures

`vectors.json` starts with the literal reference runtime and target from the
[EIP-1167 specification](https://eips.ethereum.org/EIPS/eip-1167#specification),
checked 2026-11-28. Fixtures do not import the production matcher or its constants.
Positive vectors include ordered bytes, zero, the smallest nonzero address,
the high bit, all-ff, self and leading-zero addresses, always in the full PUSH20
form with an independently stated target.

The negative vanity PUSH16 vector follows the EIP's four-leading-zero
[optimization example](https://eips.ethereum.org/EIPS/eip-1167#vanity-address-optimization),
including its adjusted jump. The PUSH0 vector is a synthetic opcode substitution,
not a claim about any additional standard. The creation wrapper is an invented
negative example; EIP-1167 does not standardize deployment bytecode. Remaining
vectors cover ordinary/empty code, prefixes, appended data, truncation and a
changed jump destination. Unsupported means this matcher does not recognize the
bytes, not that a bytecode program is invalid or cannot be a proxy.

`snapshot-v1.json` wraps the reference in invented synthetic snapshot metadata
and empty raw slots. It is not a captured network observation. Tests independently
derive strict v2/v3/v4 cases, check the raw file/code fingerprints and exact target,
mutate each fixed byte, exercise every target-byte position and refuse all shorter
vanity PUSHn forms. No production report is used as the expected-output oracle.
