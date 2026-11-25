# Independent range fixture

`inputs.json` contains four synthetic linked blocks 100–103, a separate genesis,
literal signature topics and three manually assembled EIP-1967 logs. Block 101
has no matching events. The others contain Upgraded, AdminChanged (with matching
optional timestamp) and BeaconUpgraded. Global log indices intentionally have
gaps. There is no live chain data or credential.

The fixture was assembled independently from the prior event fixture's literal
ABI bytes, without importing production encoders, decoders or capture functions.
Tests state expected addresses, coverage, queries and traversal order explicitly,
then derive bounded/adversarial cases. A production report is never the oracle.
