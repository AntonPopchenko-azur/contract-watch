# Independent timeline fixtures

All addresses, block hashes, code and timestamps in `inputs.json` are synthetic.
The three observations demonstrate a changed implementation behind one beacon,
then target code/raw-slot changes with changed implementation provenance.

`expected.json` and `expected.txt` were assembled independently of the production
history/report code. Python's hashlib computed SHA-256 of decoded code and of
sorted, compact JSON for observation IDs. The expected transitions were specified
explicitly; they were not obtained by running the timeline command. Tests build
immutable history headers/entries directly from the documented file contract.
