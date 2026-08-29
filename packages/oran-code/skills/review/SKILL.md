---
name: review
description: Review code for correctness and regressions
allowedTools:
  - run_command
mode: derived
context: recent
---

Review the requested code or changes. Prioritize concrete correctness, security, and regression findings over style preferences.

Report findings in severity order with precise file references. If no findings remain, say so explicitly.

$ARGUMENTS
