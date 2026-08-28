// Where a page's tools go.
//
// A page's tool surface should not depend on which browser opened it. With a real
// WebMCP browser the tools go to document.modelContext and an agent discovers them.
// Without one — which is every browser most people have — an identical local
// registry stands in, so /harness.html can list and fire exactly the same tools by
// hand. The pages used to register nothing at all in that case, which left the
// planner's eleven tools reachable only by an agent nobody had.
//
// The registry lives on document, not in a module binding, because /harness.html
// reads it across a same-origin frame.
export function toolHost() {
  if (!document.modelContext?.registerTool) {
    const tools = [];
    document.modelContext = { registerTool: t => tools.push(t), tools, shimmed: true };
  }
  return document.modelContext;
}
