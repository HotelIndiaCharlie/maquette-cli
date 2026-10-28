export const modes = ["ask", "auto", "plan"];
export const modeHelp = {
    ask: "reads and renders run; changes, saves and shell commands ask y/n/always",
    auto: "everything runs without asking",
    plan: "only reading; the model ends with a plan instead of making changes",
};
// By the engine's own say-so when a tool carries MCP's readOnlyHint, else by its name.
const readNames = /^(inspect|render|list|get|find|measure|read|describe|screenshot|export_text)(_|$)|_list$|^chart_list$/;
export function classify(tool) {
    if (tool.annotations?.readOnlyHint !== undefined)
        return tool.annotations.readOnlyHint ? "read" : "change";
    return readNames.test(tool.name) ? "read" : "change";
}
export function decide(mode, tool, allowed) {
    if (mode === "auto")
        return "run";
    if (classify(tool) === "read")
        return "run";
    if (mode === "plan")
        return "deny";
    return allowed.has(tool.name) ? "run" : "ask";
}
