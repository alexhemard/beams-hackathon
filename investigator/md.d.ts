// Markdown files are bundled as text (esbuild --loader:.md=text) so the investigator bundle
// carries a fallback copy of prompt.md.
declare module "*.md" {
  const text: string;
  export default text;
}
