import { ClampToEdgeWrapping, HalfFloatType, Matrix4, Vector2, Vector3 } from 'three';
import { MaterialBase } from '../MaterialBase.js';
import {
	MeshBVHUniformStruct, UIntVertexAttributeTexture,
	BVHShaderGLSL,
} from 'three-mesh-bvh';

// uniforms
import { PhysicalCameraUniform } from '../../uniforms/PhysicalCameraUniform.js';
import { EquirectHdrInfoUniform } from '../../uniforms/EquirectHdrInfoUniform.js';
import { LightsInfoUniformStruct } from '../../uniforms/LightsInfoUniformStruct.js';
import { AttributesTextureArray } from '../../uniforms/AttributesTextureArray.js';
import { MaterialsTexture } from '../../uniforms/MaterialsTexture.js';
import { RenderTarget2DArray } from '../../uniforms/RenderTarget2DArray.js';
import { StratifiedSamplesTexture } from '../../uniforms/StratifiedSamplesTexture.js';
import { BlueNoiseTexture } from '../../textures/BlueNoiseTexture.js';

// general glsl
import * as StructsGLSL from '../../shader/structs/index.js';
import * as SamplingGLSL from '../../shader/sampling/index.js';
import * as CommonGLSL from '../../shader/common/index.js';
import * as RandomGLSL from '../../shader/rand/index.js';
import * as BSDFGLSL from '../../shader/bsdf/index.js';
// Sprint 7: uniform declarations for volume scatter + SSS
// (u_volumeDensity, u_scatterAlbedo, u_anisotropyG, u_sssSigmaT, u_sssAlbedo, u_sssAnisotropyG)
import * as PTBVHGLSL from '../../shader/bvh/index.js';

// path tracer glsl
import * as RenderGLSL from './glsl/index.js';

export class PhysicalPathTracingMaterial extends MaterialBase {

	onBeforeRender() {

		this.setDefine( 'FEATURE_DOF', this.physicalCamera.bokehSize === 0 ? 0 : 1 );
		this.setDefine( 'FEATURE_BACKGROUND_MAP', this.backgroundMap ? 1 : 0 );
		this.setDefine( 'FEATURE_FOG', this.materials.features.isUsed( 'FOG' ) ? 1 : 0 );

	}

	constructor( parameters ) {

		super( {

			transparent: true,
			depthWrite: false,

			defines: {
				FEATURE_MIS: 1,
				FEATURE_RUSSIAN_ROULETTE: 1,
				FEATURE_DOF: 1,
				FEATURE_BACKGROUND_MAP: 0,
				FEATURE_FOG: 1,

				// 0 = PCG
				// 1 = Sobol
				// 2 = Stratified List
				RANDOM_TYPE: 2,

				// 0 = Perspective
				// 1 = Orthographic
				// 2 = Equirectangular
				CAMERA_TYPE: 0,

				DEBUG_MODE: 0,

				// When 1, buffer accumulates sum(rgb)/count(alpha) via additive blending (host clears to 0).
				FEATURE_ADDITIVE_ACCUM: 0,

				ATTR_NORMAL: 0,
				ATTR_TANGENT: 1,
				ATTR_UV: 2,
				ATTR_COLOR: 3,
			},

			uniforms: {

				// path trace uniforms
				resolution: { value: new Vector2() },
				opacity: { value: 1 },
				bounces: { value: 10 },
				transmissiveBounces: { value: 10 },
				filterGlossyFactor: { value: 0 },
				uRadianceClamp: { value: 0 },

				// camera uniforms
				physicalCamera: { value: new PhysicalCameraUniform() },
				cameraWorldMatrix: { value: new Matrix4() },
				invProjectionMatrix: { value: new Matrix4() },

				// scene uniforms
				bvh: { value: new MeshBVHUniformStruct() },
				attributesArray: { value: new AttributesTextureArray() },
				materialIndexAttribute: { value: new UIntVertexAttributeTexture() },
				materials: { value: new MaterialsTexture() },
				textures: { value: new RenderTarget2DArray().texture },

				// light uniforms
				lights: { value: new LightsInfoUniformStruct() },
				iesProfiles: { value: new RenderTarget2DArray( 360, 180, {
					type: HalfFloatType,
					wrapS: ClampToEdgeWrapping,
					wrapT: ClampToEdgeWrapping,
				} ).texture },
				environmentIntensity: { value: 1.0 },
				environmentRotation: { value: new Matrix4() },
				envMapInfo: { value: new EquirectHdrInfoUniform() },

				// background uniforms
				backgroundBlur: { value: 0.0 },
				backgroundMap: { value: null },
				backgroundAlpha: { value: 1.0 },
				backgroundIntensity: { value: 1.0 },
				backgroundRotation: { value: new Matrix4() },

				// randomness uniforms
				seed: { value: 0 },
				sobolTexture: { value: null },
				stratifiedTexture: { value: new StratifiedSamplesTexture() },
				stratifiedOffsetTexture: { value: new BlueNoiseTexture( 64, 1 ) },

				// Sprint 7: volume scatter uniforms (0 = disabled)
				// u_volumeDensity > 0 activates homogeneous medium haze.
				// u_scatterAlbedo = σ_s / σ_t per channel.
				// u_anisotropyG   = HG anisotropy g for the volume phase function.
				u_volumeDensity: { value: 0.0 },
				u_scatterAlbedo: { value: new Vector3( 0.8, 0.85, 0.9 ) },
				u_anisotropyG: { value: 0.0 },

				// Sprint 7: per-material SSS uniforms (u_sssSigmaT = 0 disables SSS).
				// u_sssSigmaT     = σ_t (scatter distance reciprocal).
				// u_sssAlbedo     = single-scatter albedo.
				// u_sssAnisotropyG = HG anisotropy g for SSS.
				u_sssSigmaT: { value: 0.0 },
				u_sssAlbedo: { value: new Vector3( 0.9, 0.9, 0.9 ) },
				u_sssAnisotropyG: { value: 0.0 },

				// Sprint 8: chromatic dispersion uniforms (u_dispersionStrength = 0 disables).
				// u_ior0               = base IOR at 589.3 nm (sodium D line).
				// u_dispersionStrength = Cauchy B coefficient in nm² scaled for slider.
				//                        0 = no dispersion; 0.018 = lead crystal (bevel default).
				// u_jakobCoeffs        = (c0, c1, c2) polynomial from rgbToSpectralCoefficients.
				//                        defaults to (0,0,0) → flat 50% spectrum (no chromatic weight).
				u_ior0: { value: 1.5 },
				u_dispersionStrength: { value: 0.0 },
				u_jakobCoeffs: { value: new Vector3( 0.0, 0.0, 0.0 ) },

				// Sprint 12: hero-wavelength spectral accumulator uniforms.
				// CMF arrays (81 entries each, 380–780 nm at 5 nm steps).
				// Populated from @vitrum/shared-samplers CIE_X/Y/Z_TABLE on host init.
				// uYCmfCdf[82]: normalised CDF of ȳ(λ) for hero wavelength sampling.
				// uYCmfIntegral: ∫ Y dλ (nm) ≈ 106.857.
				//
				// Sprint 12 Cauchy IOR uniforms (replaces Sprint 8 ior0 + dispersionStrength).
				// iorCauchyA/B/C in µm units; see plan/sprint-12-pt-fork-patch.md §3.
				//
				// NOTE: Ray payload restructure is in progress in the fork; uniforms are
				// still wired here directly for host upload of CMF/Cauchy data.
				uCmfX: { value: new Float32Array( 81 ) },
				uCmfY: { value: new Float32Array( 81 ) },
				uCmfZ: { value: new Float32Array( 81 ) },
				uYCmfCdf: { value: new Float32Array( 82 ) },
				uYCmfIntegral: { value: 106.857 },
				uSpectralRendering: { value: 0 },
				iorCauchyA: { value: 1.5 },
				iorCauchyB: { value: 0.0 },
				iorCauchyC: { value: 0.0 },
				// RFE-05 strategy controls bridged from @vitrum/pt-webgl.
				// 0 = none, 1 = manifold-nee approximation path, 2 = photon-map approximation path.
				uCausticStrategy: { value: 0 },
				uMneeMaxIterations: { value: 8.0 },
				uMneeMaxChainLength: { value: 3.0 },
			},

			vertexShader: /* glsl */`

				varying vec2 vUv;
				void main() {

					vec4 mvPosition = vec4( position, 1.0 );
					mvPosition = modelViewMatrix * mvPosition;
					gl_Position = projectionMatrix * mvPosition;

					vUv = uv;

				}

			`,

			fragmentShader: /* glsl */`
				#define RAY_OFFSET 1e-4
				#define INFINITY 1e20

				precision highp isampler2D;
				precision highp usampler2D;
				precision highp sampler2DArray;
				vec4 envMapTexelToLinear( vec4 a ) { return a; }
				#include <common>

				// bvh intersection
				${ BVHShaderGLSL.common_functions }
				${ BVHShaderGLSL.bvh_struct_definitions }
				${ BVHShaderGLSL.bvh_ray_functions }

				// uniform structs
				${ StructsGLSL.camera_struct }
				${ StructsGLSL.lights_struct }
				${ StructsGLSL.equirect_struct }
				${ StructsGLSL.material_struct }
				${ StructsGLSL.surface_record_struct }

				// random
				#if RANDOM_TYPE == 2 	// Stratified List

					${ RandomGLSL.stratified_functions }

				#elif RANDOM_TYPE == 1 	// Sobol

					${ RandomGLSL.pcg_functions }
					${ RandomGLSL.sobol_common }
					${ RandomGLSL.sobol_functions }

					#define rand(v) sobol(v)
					#define rand2(v) sobol2(v)
					#define rand3(v) sobol3(v)
					#define rand4(v) sobol4(v)

				#else 					// PCG

				${ RandomGLSL.pcg_functions }

					// Using the sobol functions seems to break the the compiler on MacOS
					// - specifically the "sobolReverseBits" function.
					uint sobolPixelIndex = 0u;
					uint sobolPathIndex = 0u;
					uint sobolBounceIndex = 0u;

					#define rand(v) pcgRand()
					#define rand2(v) pcgRand2()
					#define rand3(v) pcgRand3()
					#define rand4(v) pcgRand4()

				#endif

				// common
				${ CommonGLSL.texture_sample_functions }
				${ CommonGLSL.fresnel_functions }
				${ CommonGLSL.util_functions }
				${ CommonGLSL.math_functions }
				${ CommonGLSL.shape_intersection_functions }

				// environment
				uniform EquirectHdrInfo envMapInfo;
				uniform mat4 environmentRotation;
				uniform float environmentIntensity;

				// lighting
				uniform sampler2DArray iesProfiles;
				uniform LightsInfo lights;

				// background
				uniform float backgroundBlur;
				uniform float backgroundAlpha;
				#if FEATURE_BACKGROUND_MAP

				uniform sampler2D backgroundMap;
				uniform mat4 backgroundRotation;
				uniform float backgroundIntensity;

				#endif

				// camera
				uniform mat4 cameraWorldMatrix;
				uniform mat4 invProjectionMatrix;
				#if FEATURE_DOF

				uniform PhysicalCamera physicalCamera;

				#endif

				// geometry
				uniform sampler2DArray attributesArray;
				uniform usampler2D materialIndexAttribute;
				uniform sampler2D materials;
				uniform sampler2DArray textures;
				uniform BVH bvh;

				// path tracer
				uniform int bounces;
				uniform int transmissiveBounces;
				uniform float filterGlossyFactor;
				uniform float uRadianceClamp;
				uniform int seed;

				// image
				uniform vec2 resolution;
				uniform float opacity;

				varying vec2 vUv;

				// globals
				mat3 envRotation3x3;
				mat3 invEnvRotation3x3;
				float lightsDenom;

				// sampling
				${ SamplingGLSL.shape_sampling_functions }
				${ SamplingGLSL.equirect_functions }
				${ SamplingGLSL.light_sampling_functions }

				// Sprint 7: volume scatter + SSS uniforms
				uniform float u_volumeDensity;
				uniform vec3 u_scatterAlbedo;
				uniform float u_anisotropyG;
				uniform float u_sssSigmaT;
				uniform vec3 u_sssAlbedo;
				uniform float u_sssAnisotropyG;

				// Sprint 8: chromatic dispersion uniforms
				uniform float u_ior0;
				uniform float u_dispersionStrength;
				uniform vec3 u_jakobCoeffs;
				uniform float iorCauchyA;
				uniform float iorCauchyB;
				uniform float iorCauchyC;
				uniform int uCausticStrategy;
				uniform float uMneeMaxIterations;
				uniform float uMneeMaxChainLength;

				${ PTBVHGLSL.inside_fog_volume_function }
				${ BSDFGLSL.ggx_functions }
				${ BSDFGLSL.sheen_functions }
				${ BSDFGLSL.iridescence_functions }
				${ BSDFGLSL.fog_functions }
				${ BSDFGLSL.volume_march }
				${ BSDFGLSL.spectral_accumulator }
				${ BSDFGLSL.thin_film_tmm }
				${ BSDFGLSL.bsdf_functions }

				float applyFilteredGlossy( float roughness, float accumulatedRoughness ) {

					return clamp(
						max(
							roughness,
							accumulatedRoughness * filterGlossyFactor * 5.0 ),
						0.0,
						1.0
					);

				}

				vec3 sampleBackground( vec3 direction, vec2 uv ) {

					vec3 sampleDir = sampleHemisphere( direction, uv ) * 0.5 * backgroundBlur;

					#if FEATURE_BACKGROUND_MAP

					sampleDir = normalize( mat3( backgroundRotation ) * direction + sampleDir );
					return backgroundIntensity * sampleEquirectColor( backgroundMap, sampleDir );

					#else

					sampleDir = normalize( envRotation3x3 * direction + sampleDir );
					return environmentIntensity * sampleEquirectColor( envMapInfo.map, sampleDir );

					#endif

				}

				${ RenderGLSL.render_structs }
				${ RenderGLSL.camera_util_functions }
				${ RenderGLSL.trace_scene_function }
				${ RenderGLSL.attenuate_hit_function }
				${ RenderGLSL.direct_light_contribution_function }
				${ RenderGLSL.get_surface_record_function }

				void main() {

					// init
					rng_initialize( gl_FragCoord.xy, seed );
					sobolPixelIndex = ( uint( gl_FragCoord.x ) << 16 ) | uint( gl_FragCoord.y );
					sobolPathIndex = uint( seed );

					// get camera ray
					Ray ray = getCameraRay();

					// inverse environment rotation
					envRotation3x3 = mat3( environmentRotation );
					invEnvRotation3x3 = inverse( envRotation3x3 );
					lightsDenom =
						( environmentIntensity == 0.0 || envMapInfo.totalSum == 0.0 ) && lights.count != 0u ?
							float( lights.count ) :
							float( lights.count + 1u );

					// final color
					gl_FragColor = vec4( 0, 0, 0, 1 );

					// surface results
					SurfaceHit surfaceHit;
					ScatterRecord scatterRec;

					// path tracing state
					RenderState state = initRenderState();
					state.wavelength = sampleHeroWavelength( rand( 30 ), state.wavelengthPdf );
					state.transmissiveTraversals = transmissiveBounces;
					#if FEATURE_FOG

					state.fogMaterial.fogVolume = bvhIntersectFogVolumeHit(
						ray.origin, - ray.direction,
						materialIndexAttribute, materials,
						state.fogMaterial
					);

					#endif

					for ( int i = 0; i < bounces; i ++ ) {

						sobolBounceIndex ++;

						state.depth ++;
						state.traversals = bounces - i;
						state.firstRay = i == 0 && state.transmissiveTraversals == transmissiveBounces;

						int hitType = traceScene( ray, state.fogMaterial, surfaceHit );
						vec3 throughputRgb = wavelengthToRGB( state.wavelength, state.throughput, state.wavelengthPdf );

						// Sprint 7: Volume scatter event — homogeneous medium march.
						// If u_volumeDensity > 0, sample a potential scatter distance.
						// If tScatter < tSurface, a scatter event occurs before the surface hit.
						// Fast path: skipped entirely when u_volumeDensity == 0 (no medium).
						if ( u_volumeDensity > 0.0 ) {
							float tSurface7 = hitType == NO_HIT ? 1e20 : surfaceHit.dist;
							float tScatter = volumeMarch( ray.origin, ray.direction, tSurface7, rand( 20 ) );
							if ( tScatter < tSurface7 ) {
								// Scatter event before the surface — evaluate HG phase,
								// sample new direction, apply transmittance weight.
								vec3 scatterPos = ray.origin + tScatter * ray.direction;

								// Choose new scattered direction via HG sampling.
								vec3 scatterDir = sampleHG_glsl( rand( 21 ), rand( 22 ), u_anisotropyG, ray.direction );
								// Beer-Lambert transmittance to scatter point.
								float transmittance = exp( - u_volumeDensity * tScatter );

								// Throughput update: albedo × phase / (pdf × transmittance normalisation).
								// For single-scatter: throughput *= σ_s × phase(cosθ) / (σ_t × phase(cosθ))
								//                               = σ_s / σ_t = scatterAlbedo
								// The phase function cancels since we importance-sample from HG (pdf = phase).
								state.throughput *= heroWeightFromRgb( u_scatterAlbedo, state.wavelength ) * transmittance;

								// Advance ray from scatter position with new direction.
								ray.origin = scatterPos;
								ray.direction = scatterDir;
								state.transmissiveRay = false;
								continue;
							}
						}

						// check if we intersect any lights and accumulate the light contribution
						// TODO: we can add support for light surface rendering in the else condition if we
						// add the ability to toggle visibility of the the light
						if ( ! state.firstRay && ! state.transmissiveRay ) {

							LightRecord lightRec;
							float lightDist = hitType == NO_HIT ? INFINITY : surfaceHit.dist;
							for ( uint i = 0u; i < lights.count; i ++ ) {

								if (
									intersectLightAtIndex( lights.tex, ray.origin, ray.direction, i, lightRec ) &&
									lightRec.dist < lightDist
								) {

									#if FEATURE_MIS

									// weight the contribution
									// NOTE: Only area lights are supported for forward sampling and can be hit
									float misWeight = misHeuristic( scatterRec.pdf, lightRec.pdf / lightsDenom );
									gl_FragColor.rgb += lightRec.emission * throughputRgb * misWeight;

									#else

									gl_FragColor.rgb += lightRec.emission * throughputRgb;

									#endif

								}

							}

						}

						if ( hitType == NO_HIT ) {

							if ( state.firstRay || state.transmissiveRay ) {

								gl_FragColor.rgb += sampleBackground( ray.direction, rand2( 2 ) ) * throughputRgb;
								#if FEATURE_ADDITIVE_ACCUM

								gl_FragColor.a = 1.0;

								#else

								gl_FragColor.a = backgroundAlpha;

								#endif

							} else {

								#if FEATURE_MIS

								// get the PDF of the hit envmap point
								vec3 envColor;
								float envPdf = sampleEquirect( envRotation3x3 * ray.direction, envColor );
								envPdf /= lightsDenom;

								// and weight the contribution
								float misWeight = misHeuristic( scatterRec.pdf, envPdf );
								gl_FragColor.rgb += environmentIntensity * envColor * throughputRgb * misWeight;

								#else

								gl_FragColor.rgb +=
									environmentIntensity *
									sampleEquirectColor( envMapInfo.map, envRotation3x3 * ray.direction ) *
									throughputRgb;

								#endif

							}
							break;

						}

						uint materialIndex = uTexelFetch1D( materialIndexAttribute, surfaceHit.faceIndices.x ).r;
						Material material = readMaterialInfo( materials, materialIndex );

						#if FEATURE_FOG

						if ( hitType == FOG_HIT ) {

							material = state.fogMaterial;
							state.accumulatedRoughness += 0.2;

						} else if ( material.fogVolume ) {

							state.fogMaterial = material;
							state.fogMaterial.fogVolume = surfaceHit.side == 1.0;

							ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );

							i -= sign( state.transmissiveTraversals );
							state.transmissiveTraversals -= sign( state.transmissiveTraversals );
							continue;

						}

						#endif

						// early out if this is a matte material
						if ( material.matte && state.firstRay ) {

							#if FEATURE_ADDITIVE_ACCUM

							gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );

							#else

							gl_FragColor = vec4( 0.0 );

							#endif
							break;

						}

						// if we've determined that this is a shadow ray and we've hit an item with no shadow casting
						// then skip it
						if ( ! material.castShadow && state.isShadowRay ) {

							ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );
							continue;

						}

						SurfaceRecord surf;
						if (
							getSurfaceRecord(
								material, materialIndex, surfaceHit, attributesArray, state.accumulatedRoughness,
								surf
							) == SKIP_SURFACE
						) {

							// only allow a limited number of transparency discards otherwise we could
							// crash the context with too long a loop.
							i -= sign( state.transmissiveTraversals );
							state.transmissiveTraversals -= sign( state.transmissiveTraversals );

							ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );
							continue;

						}

						// Sprint 7: gate SSS by per-material TRANSLUCENT_BIT and back-face traversal.
						// Falls back to standard BSDF sampling for non-translucent materials.
						bool canUseSss =
							surf.sssSigmaT > 0.0 &&
							( ( material.flags & TRANSLUCENT_BIT ) != 0u ) &&
							! surf.frontFace;
						if ( canUseSss ) {
							scatterRec = sssSample( - ray.direction, surf, state.wavelength );
							scatterRec.throughput *= activeLayerWeight( surf, state.wavelength );
						} else {
							scatterRec = bsdfSample( - ray.direction, surf, state.wavelength );
						}
						state.isShadowRay = scatterRec.specularPdf < rand( 4 );

						bool isBelowSurface = ! surf.volumeParticle && dot( scatterRec.direction, surf.faceNormal ) < 0.0;
						vec3 hitPoint = stepRayOrigin( ray.origin, ray.direction, isBelowSurface ? - surf.faceNormal : surf.faceNormal, surfaceHit.dist );

						// next event estimation
						#if FEATURE_MIS

						gl_FragColor.rgb += directLightContribution( - ray.direction, surf, state, hitPoint );

						#endif

						// RFE-05 strategy behavior hook:
						// strategy 1 => deterministic refractive-chain connection walk.
						// strategy 2 => deterministic cone-traced caustic density estimate.
						if ( uCausticStrategy > 0 && surf.transmission > 0.0 ) {
							if ( uCausticStrategy == 1 ) {
								// Skip manifold mode on rough refractive surfaces: the fixed-step
								// walk is intended for near-specular interfaces.
								if ( surf.filteredRoughness < 0.12 ) {
									float etaM = surf.frontFace ? ( 1.0 / max( surf.ior, 1.0 ) ) : max( surf.ior, 1.0 );
									vec3 walkDir = refract( ray.direction, surf.normal, etaM );
									if ( length( walkDir ) > 0.0 ) {
										walkDir = normalize( walkDir );
										vec3 walkOrigin = hitPoint;
										int maxWalkIter = int( clamp( floor( uMneeMaxIterations + 0.5 ), 1.0, 16.0 ) );
										int maxChain = int( clamp( floor( uMneeMaxChainLength + 0.5 ), 1.0, 8.0 ) );
										int traversedChain = 0;
										bool reachedLight = false;
										float chainAttenuation = 1.0;
										for ( int walkIter = 0; walkIter < 16; walkIter ++ ) {
											if ( walkIter >= maxWalkIter || traversedChain >= maxChain ) break;
											Ray walkRay;
											walkRay.origin = walkOrigin;
											walkRay.direction = walkDir;
											SurfaceHit walkHit;
											int walkHitType = traceScene( walkRay, state.fogMaterial, walkHit );
											if ( walkHitType == NO_HIT ) {
												reachedLight = true;
												break;
											}
											uint walkMaterialIndex = uTexelFetch1D( materialIndexAttribute, walkHit.faceIndices.x ).r;
											Material walkMaterial = readMaterialInfo( materials, walkMaterialIndex );
											if ( walkMaterial.transmission <= 0.0 ) {
												break;
											}
											vec3 walkHitPoint = stepRayOrigin( walkOrigin, walkDir, walkHit.faceNormal, walkHit.dist );
											float etaWalk = walkHit.side > 0.0
												? ( 1.0 / max( walkMaterial.ior, 1.0 ) )
												: max( walkMaterial.ior, 1.0 );
											vec3 nextDir = refract( walkDir, walkHit.faceNormal, etaWalk );
											if ( length( nextDir ) <= 1e-5 ) {
												break;
											}
											walkOrigin = walkHitPoint;
											walkDir = normalize( nextDir );
											chainAttenuation *= clamp( walkMaterial.transmission, 0.0, 1.0 );
											traversedChain ++;
										}
										if ( reachedLight ) {
											float focus = pow( max( dot( walkDir, - ray.direction ), 0.0 ), 10.0 );
											float chainNorm = 1.0 / max( float( traversedChain + 1 ), 1.0 );
											float manifoldWeight = focus * chainNorm * chainAttenuation;
											gl_FragColor.rgb += throughputRgb * surf.color * manifoldWeight;
										}
									}
								}
							} else if ( uCausticStrategy == 2 ) {
								// Photon-density style estimate: cast a deterministic refracted cone
								// and estimate visible light density with an inverse-distance kernel.
								float etaP = surf.frontFace ? ( 1.0 / max( surf.ior, 1.0 ) ) : max( surf.ior, 1.0 );
								vec3 refrDir = refract( ray.direction, surf.normal, etaP );
								if ( length( refrDir ) > 0.0 ) {
									refrDir = normalize( refrDir );
									vec3 tangentA = normalize( abs( refrDir.x ) > 0.5 ? cross( refrDir, vec3( 0.0, 1.0, 0.0 ) ) : cross( refrDir, vec3( 1.0, 0.0, 0.0 ) ) );
									vec3 tangentB = normalize( cross( refrDir, tangentA ) );
									float coneRadius = mix( 0.01, 0.12, clamp( surf.filteredRoughness, 0.0, 1.0 ) );
									float photonAccum = 0.0;
									const int PHOTON_SAMPLES = 8;
									for ( int p = 0; p < PHOTON_SAMPLES; p ++ ) {
										float u = ( float( p ) + 0.5 ) / float( PHOTON_SAMPLES );
										float v = rand( 42 + p );
										float r = coneRadius * sqrt( u );
										float phi = 6.28318530718 * v;
										vec3 coneDir = normalize( refrDir + ( cos( phi ) * r ) * tangentA + ( sin( phi ) * r ) * tangentB );
										Ray photonRay;
										photonRay.origin = hitPoint;
										photonRay.direction = coneDir;
										SurfaceHit photonHit;
										int photonHitType = traceScene( photonRay, state.fogMaterial, photonHit );
										if ( photonHitType == NO_HIT ) {
											photonAccum += 1.0;
										} else {
											float d = max( photonHit.dist, 1e-3 );
											photonAccum += 1.0 / ( 1.0 + d * d );
										}
									}
									float density = photonAccum / float( PHOTON_SAMPLES );
									gl_FragColor.rgb += throughputRgb * surf.color * density * surf.transmission;
								}
							}
						}

						// accumulate a roughness value to offset diffuse, specular, diffuse rays that have high contribution
						// to a single pixel resulting in fireflies
						// TODO: handle transmissive surfaces
						if ( ! surf.volumeParticle && ! isBelowSurface ) {

							// determine if this is a rough normal or not by checking how far off straight up it is
							vec3 halfVector = normalize( - ray.direction + scatterRec.direction );
							state.accumulatedRoughness += max(
								sin( acosApprox( dot( halfVector, surf.normal ) ) ),
								sin( acosApprox( dot( halfVector, surf.clearcoatNormal ) ) )
							);

							state.transmissiveRay = false;

						}

						// accumulate emissive color
						gl_FragColor.rgb += ( surf.emission * throughputRgb );

						// skip the sample if our PDF or ray is impossible
						if ( scatterRec.pdf <= 0.0 || ! isDirectionValid( scatterRec.direction, surf.normal, surf.faceNormal ) ) {

							break;

						}

						// if we're bouncing around the inside a transmissive material then decrement
						// perform this separate from a bounce
						bool isTransmissiveRay = ! surf.volumeParticle && dot( scatterRec.direction, surf.faceNormal * surfaceHit.side ) < 0.0;
						if ( ( isTransmissiveRay || isBelowSurface ) && state.transmissiveTraversals > 0 ) {

							state.transmissiveTraversals --;
							i --;

						}

						//

						// handle throughput color transformation
						// attenuate the throughput color by the medium color
						if ( ! surf.frontFace ) {

							state.throughput *= transmissionAttenuationHero(
								materials,
								surfaceHit.dist,
								surf.attenuationColor,
								surf.attenuationDistance,
								surf.hasSpectralAttenuation,
								surf.materialIndex,
								state.wavelength
							);

						}

						#if FEATURE_RUSSIAN_ROULETTE

						// russian roulette path termination
						// https://www.arnoldrenderer.com/research/physically_based_shader_design_in_arnold.pdf
						uint minBounces = 3u;
						float depthProb = float( state.depth < minBounces );

						float rrProb = scatterRec.throughput / max( scatterRec.pdf, 1e-6 );
						rrProb = sqrt( rrProb );
						rrProb = max( rrProb, depthProb );
						rrProb = min( rrProb, 1.0 );
						if ( rand( 8 ) > rrProb ) {

							break;

						}

						// perform sample clamping here to avoid bright pixels
						state.throughput *= min( 1.0 / rrProb, 20.0 );

						#endif

						// adjust the throughput and discard and exit if we find discard the sample if there are any NaNs
						state.throughput *= scatterRec.throughput / scatterRec.pdf;
						if ( isnan( state.throughput ) || isinf( state.throughput ) ) {

							break;

						}

						//

						// prepare for next ray
						ray.direction = scatterRec.direction;
						ray.origin = hitPoint;

					}

					if ( uRadianceClamp > 0.0 ) {
						float sampleLuminance = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
						if ( sampleLuminance > uRadianceClamp ) {
							gl_FragColor.rgb *= uRadianceClamp / sampleLuminance;
						}
					}

					#if FEATURE_ADDITIVE_ACCUM

					gl_FragColor.a = 1.0;

					#else

					gl_FragColor.a *= opacity;

					#endif

					#if DEBUG_MODE == 1

					// output the number of rays checked in the path and number of
					// transmissive rays encountered.
					gl_FragColor.rgb = vec3(
						float( state.depth ),
						transmissiveBounces - state.transmissiveTraversals,
						0.0
					);
					gl_FragColor.a = 1.0;

					#endif

				}

			`

		} );

		this.setValues( parameters );

	}

}
