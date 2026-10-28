// Ink without JSX: Node runs .ts source as is but not .tsx, so components are plain
// functions calling React.createElement through `h`.
import React from "react";

export const h = React.createElement;
export { Box, Static, Text, useApp, useInput, useStdout } from "ink";
export { useEffect, useRef, useState } from "react";
export type { ReactNode } from "react";
