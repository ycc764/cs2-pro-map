/** 注册 scripts/dev/loader.mjs 这个解析钩子，供 --import 使用。 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
