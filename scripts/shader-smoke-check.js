import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relPath) {
	return readFileSync(resolve(process.cwd(), relPath), 'utf8');
}

function expectMatch(text, pattern, message) {
	if (!pattern.test(text)) {
		throw new Error(message);
	}
}

function expectNoMatch(text, pattern, message) {
	if (pattern.test(text)) {
		throw new Error(message);
	}
}

const renderStructs = read('./src/materials/pathtracing/glsl/render_structs.glsl.js');
const directLight = read('./src/materials/pathtracing/glsl/direct_light_contribution_function.glsl.js');
const bsdf = read('./src/shader/bsdf/bsdf_functions.glsl.js');
const util = read('./src/shader/common/util_functions.glsl.js');
const materialMain = read('./src/materials/pathtracing/PhysicalPathTracingMaterial.js');

expectMatch(renderStructs, /float wavelength;/, 'RenderState missing wavelength field');
expectMatch(renderStructs, /float wavelengthPdf;/, 'RenderState missing wavelengthPdf field');
expectMatch(renderStructs, /float throughput;/, 'RenderState missing scalar throughput field');
expectNoMatch(renderStructs, /throughputColor/, 'RenderState still contains legacy throughputColor');

expectMatch(
	directLight,
	/wavelengthToRGB\s*\(\s*state\.wavelength\s*,\s*state\.throughput\s*,\s*state\.wavelengthPdf\s*\)/,
	'direct_light_contribution is not using hero-wavelength throughput conversion',
);
expectNoMatch(directLight, /throughputColor/, 'direct_light_contribution still references throughputColor');

expectMatch(
	bsdf,
	/ScatterRecord bsdfSample\(\s*vec3 worldWo,\s*SurfaceRecord surf,\s*float heroWavelength\s*\)/,
	'bsdfSample signature missing hero wavelength parameter',
);
expectMatch(
	bsdf,
	/ScatterRecord sssSample\(\s*vec3 worldWo,\s*SurfaceRecord surf,\s*float heroWavelength\s*\)/,
	'sssSample signature missing hero wavelength parameter',
);
expectNoMatch(bsdf, /TODO\(sprint-7-flags\)/, 'Stale sprint-7 flags TODO still present in bsdf_functions');

expectMatch(util, /float heroWeightFromRgb\(/, 'heroWeightFromRgb helper missing');

expectMatch(
	materialMain,
	/bsdfSample\s*\(\s*-\s*ray\.direction,\s*surf,\s*state\.wavelength\s*\)/,
	'PhysicalPathTracingMaterial must call bsdfSample with hero wavelength',
);
expectMatch(
	materialMain,
	/sssSample\s*\(\s*-\s*ray\.direction,\s*surf,\s*state\.wavelength\s*\)/,
	'PhysicalPathTracingMaterial must call sssSample with hero wavelength',
);

console.log('Shader smoke checks passed.');
