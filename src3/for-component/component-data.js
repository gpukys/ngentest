const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const windowObjects = require('../window-objects.js');

class ComponentData {
  constructor ({ tsPath, klass, imports }) {
    // this.template;
    this.imports = imports;
    this.klass = klass;

    this.tsPath = tsPath;
    this.typescript = fs.readFileSync(path.resolve(tsPath), 'utf8');
  }

  getEjsData () {
    const result = {};
    this.template = fs.readFileSync(path.join(__dirname, 'component.template.ts.ejs'), 'utf8');

    result.className = this.klass.name;
    result.inputs = this._getInputs(this.klass);
    result.outputs = this._getOutputs(this.klass);
    result.providers = this._getProviders(this.klass);
    result.mocks = this._getMocks(this.klass);
    result.functionTests = this._getItBlocks(this.klass);
    result.imports = this._getImports(this.klass);
    result.parsedImports = this.imports;

    return result;
  }

  getGenerated (ejsData) {
    const generated = ejs.render(this.template, ejsData).replace(/\n\s+$/gm, '\n');
    return generated;
  }

  _getInputs (klass) {
    const inputs = { attributes: [], properties: [] };
    (klass.properties || []).forEach(prop => {
      const key = prop.name;
      const body = this.typescript.substring(prop.start, prop.end);
      if (body.match(/@Input\(/)) {
        const attrName = (prop.body.match(/@Input\(['"](.*?)['"]\)/) || [])[1];
        inputs.attributes.push(`[${attrName || key}]="${key}"`);
        inputs.properties.push(`${key}: ${prop.type};`);
      }
    });

    return inputs;
  }

  _getOutputs (klass) {
    const outputs = { attributes: [], properties: [] };
    (klass.properties || []).forEach(prop => {
      const key = prop.name;
      const body = this.typescript.substring(prop.start, prop.end);
      if (body.match(/@Output\(/)) {
        const attrName = (prop.body.match(/@Output\(['"](.*?)['"]\)/) || [])[1];
        const funcName = `on${key.replace(/^[a-z]/, x => x.toUpperCase())}`;
        outputs.attributes.push(`(${attrName || key})="${funcName}($event)"`);
        outputs.properties.push(`${funcName}(event): void { /* */ }`);
      }
    });

    return outputs;
  }

  // Iterate methods, getnerate test with the function with parameter;
  _getItBlocks (klass) {
    const blocks = {};
    (klass.methods || []).forEach(method => {
      const testName = `should run #${method.name}()`;
      // const parameters = (method.parameters || []).map(param => param.name).join(', ');

      blocks[method.name] = this._reIndent(`
        it('${testName}', async () => {
        });`, '  ');
    });

    return blocks;
  }

  _getImports (klass) {
    const imports = {};
    const constructorParams = (klass.ctor && klass.ctor.parameters) || [];

    imports['@angular/core'] = ['Component'];
    imports[`./${path.basename(this.tsPath)}`.replace(/.ts$/, '')] = [klass.name];

    constructorParams.forEach(param => {
      const paramBody = this.typescript.substring(param.start, param.end);

      const injectMatches = paramBody.match(/@Inject\(([A-Z0-9_]+)\)/) || [];
      const injectClassName = injectMatches[1];
      if (injectClassName) { // e.g. @Inject(LOCALE_ID) language
        const iimport = this.imports[injectClassName];
        imports[iimport.mport.libraryName] = imports[iimport.mport.libraryName] || [];
        imports[iimport.mport.libraryName].push(injectClassName);
        imports[iimport.mport.libraryName].push(param.type);
      } else {
        const iimport = this.imports[param.type];
        const importStr = iimport.mport.alias ?
          `${iimport.specifier.specifier} as ${iimport.mport.alias}` : iimport.specifier.specifier;
        imports[iimport.mport.libraryName] = imports[iimport.mport.libraryName] || [];
        imports[iimport.mport.libraryName].push(importStr);
      }
    });

    return imports;
  }

  /* @returns @Component providers: code */
  _getProviders (klass) {
    const constructorParams = (klass.ctor && klass.ctor.parameters) || [];
    const providers = {};

    constructorParams.forEach(param => { // name, type, start, end
      const paramBody = this.typescript.substring(param.start, param.end);
      const injectMatches = paramBody.match(/@Inject\(([A-Z0-9_]+)\)/) || [];
      const injectClassName = injectMatches[1];
      const iimport = this.imports[param.type];

      if (injectClassName === 'PLATFORM_ID') {
        providers[param.name] = { provide: `PLATFORM_ID`, useValue: 'browser' };
      } else if (injectClassName === 'LOCALE_ID') {
        providers[param.name] = { provide: `LOCALE_ID`, useValue: 'en' };
      } else if (param.type === 'ElementRef' || param.type === 'Router') {
        providers[param.name] = { provide: `${param.type}`, useClass: `Mock${param.type}` };
      } else if (iimport.mport.libraryName.match(/^[\.]+/)) { // user-defined classes
        providers[param.name] = { provide: `${param.type}`, useClass: `Mock${param.type}` };
      } else {
        providers[param.name] = `${param.type}`;
      }
    });

    return providers;
  }

  /* @returns mock data for this test */
  _getMocks (klass) {
    const mocks = {};

    (klass.properties || []).forEach(prop => {
      // const key = prop.name;
      const basicTypes = ['Object', 'boolean', 'number', 'string', 'Array', 'any', 'void', 'null', 'undefined', 'never'];
      if (windowObjects.includes(prop.type) && !basicTypes.includes(prop.type)) {
        mocks[prop.type] = `(<any>window).${prop.type} = jest.fn();\n`;
      }
    });

    const constructorParams = (klass.ctor && klass.ctor.parameters) || [];
    constructorParams.forEach(param => {
      const iimport = this.imports[param.type];

      if (param.type === 'ElementRef') {
        mocks[param.type] = this._reIndent(`
          @Injectable()
          class Mock${param.type} {
            // constructor() { super(undefined); }
            nativeElement = {}
          }`);
      } else if (param.type === 'Router') {
        mocks[param.type] = this._reIndent(`
          @Injectable()
          class Mock${param.type} { navigate = jest.fn(); }
        `);
      } else {
        if (iimport && iimport.mport.libraryName.match(/^[\.]+/)) {  // starts from . or .., which is a user-defined provider
          mocks[param.type] = this._reIndent(`
            @Injectable()
            class Mock${param.type} { }
          `);
        } else {
          // console.log('XXXXXXXXXXXXXXXXXXXXXX', param);
        }
      }
    });

    return mocks;
  }

  _reIndent (str, prefix = '') {
    const toRepl = str.match(/^\n\s+/)[0];
    const regExp = new RegExp(toRepl, 'gm');
    return str.replace(regExp, '\n' + prefix);
  }
}

module.exports = ComponentData;