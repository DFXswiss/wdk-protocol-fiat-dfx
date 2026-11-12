// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

// Tokenize strings before numbers so digits and escaped quotes inside strings stay intact.
export function parseNumbers (text) {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\[\s\S])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*:)?/g, (token, number, key) => {
    // Do not repair invalid unquoted numeric object keys into valid JSON.
    return number === undefined || key ? token : JSON.stringify(number)
  }))
}
