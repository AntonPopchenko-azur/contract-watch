# Independent retention plan

All input addresses, code, hashes and capture times are synthetic. The source
contains a change followed by a return to the baseline state, then decreasing
height/time observations. The plan keeps original ordinals 1, 4 and 5; neither
height nor capture time determines selection.

The expected plan was assembled without running the production planner. Python
hashlib computed snapshot byte hashes, canonical observation IDs and the plan ID
from the documented JSON contract. The pure-policy fixture uses `f` repeated 64
times as its explicit source-state binding. Integration tests use actual
filesystem bindings, independently check plan IDs, compare the same expected
observation decisions and verify that any source state change invalidates apply.
