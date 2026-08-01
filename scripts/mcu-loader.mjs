// ESM resolve-hook: чинит MCU 0.4.0 (extensionless imports при type:module).
import { register } from 'node:module';
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND'
        && (context.parentURL || '').includes('material-color-utilities')
        && !/\.[cm]?js$/.test(specifier)) {
      return await next(specifier + '.js', context);
    }
    throw e;
  }
}
