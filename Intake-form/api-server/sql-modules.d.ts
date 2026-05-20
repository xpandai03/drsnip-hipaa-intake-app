// Ambient declaration so `.sql` files can be imported as strings. esbuild
// inlines them at bundle time via the `.sql=text` loader (see build:migrate).
declare module "*.sql" {
  const content: string;
  export default content;
}
