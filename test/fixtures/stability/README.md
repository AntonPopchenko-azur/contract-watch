# Synthetic consecutive-observation fixture

`flapping.json` was hand assembled for item 30 on 2026-10-20. A/B/C are three
invented target-code states (0x6000/0x6001/0x6002), with identical synthetic raw
slots at consecutive synthetic block heights starting at 100. Block hashes are
the height left-padded to 32 bytes. These are not observations from a network.

The expected decision sequence is independent of the policy implementation:
first A is the reference; B/A cancels a one-match candidate; the next B/B
qualifies, then C/C qualifies, then A/A qualifies as a return transition.
The fixture pins ordinal references, candidate counts and transition confirmations.
It intentionally does not infer event timing, ancestry, finality or safety.
