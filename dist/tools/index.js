// The tool modules Maquette loads, in the order their tools are listed.
import chart from "./chart/index.js";
import memory from "./memory/index.js";
import survey from "./survey/index.js";
import workspace from "./workspace/index.js";
export const modules = [chart, survey, memory, workspace];
