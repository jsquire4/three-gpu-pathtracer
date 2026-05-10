/*
wi     : incident vector or light vector (pointing toward the light)
wo     : outgoing vector or view vector (pointing towards the camera)
wh     : computed half vector from wo and wi
Eval   : Get the color and pdf for a direction
Sample : Get the direction, color, and pdf for a sample
eta    : Greek character used to denote the "ratio of ior"
f0     : Amount of light reflected when looking at a surface head on - "fresnel 0"
f90    : Amount of light reflected at grazing angles
*/

export const bsdf_functions = /* glsl */`

	// Sprint 7: TRANSLUCENT material flag bit for per-material SSS gating.
	// Packed in MaterialsTexture sample 14 and unpacked by readMaterialInfo().
	const uint TRANSLUCENT_BIT = 0x10u;  // bit 4

	// Approximate scalar spectral weight at the hero wavelength from an RGB triplet.
	// This keeps the payload scalar while preserving wavelength-dependent material response.
	float heroWeightFromRgb( vec3 rgb, float heroWavelength ) {
		float tB = 1.0 - smoothstep( 470.0, 530.0, heroWavelength );
		float tR = smoothstep( 570.0, 650.0, heroWavelength );
		float tG = clamp( 1.0 - tB - tR, 0.0, 1.0 );
		return max( dot( rgb, vec3( tR, tG, tB ) ), 0.0 );
	}

	float activeLayerWeight( SurfaceRecord surf, float heroWavelength ) {
		if ( ! surf.hasActiveLayer ) return 1.0;
		return heroWeightFromRgb( surf.activeLayerTransmission, heroWavelength );
	}

	// diffuse
	float diffuseEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, float heroWavelength, inout float throughput ) {

		// https://schuttejoe.github.io/post/disneybsdf/
		float fl = schlickFresnel( wi.z, 0.0 );
		float fv = schlickFresnel( wo.z, 0.0 );

		float metalFactor = ( 1.0 - surf.metalness );
		float transFactor = ( 1.0 - surf.transmission );
		float rr = 0.5 + 2.0 * surf.roughness * fl * fl;
		float retro = rr * ( fl + fv + fl * fv * ( rr - 1.0f ) );
		float lambert = ( 1.0f - 0.5f * fl ) * ( 1.0f - 0.5f * fv );

		// TODO: subsurface approx?

		// float F = evaluateFresnelWeight( dot( wo, wh ), surf.eta, surf.f0 );
		float F = disneyFresnel( wo, wi, wh, surf.f0, surf.eta, surf.metalness );
		float albedo = heroWeightFromRgb( surf.color, heroWavelength );
		throughput = ( 1.0 - F ) * transFactor * metalFactor * wi.z * albedo * ( retro + lambert ) / PI;

		return wi.z / PI;

	}

	vec3 diffuseDirection( vec3 wo, SurfaceRecord surf ) {

		vec3 lightDirection = sampleSphere( rand2( 11 ) );
		lightDirection.z += 1.0;
		lightDirection = normalize( lightDirection );

		return lightDirection;

	}

	// specular
	float specularEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, float heroWavelength, inout float throughput ) {

		// if roughness is set to 0 then D === NaN which results in black pixels
		float metalness = surf.metalness;
		float roughness = surf.filteredRoughness;

		float eta = surf.eta;
		float f0 = surf.f0;

		vec3 f0Color = mix( f0 * surf.specularColor * surf.specularIntensity, surf.color, surf.metalness );
		vec3 f90Color = vec3( mix( surf.specularIntensity, 1.0, surf.metalness ) );
		vec3 F = evaluateFresnel( dot( wo, wh ), eta, f0Color, f90Color );

		vec3 iridescenceF = evalIridescence( 1.0, surf.iridescenceIor, dot( wi, wh ), surf.iridescenceThickness, f0Color );
		F = mix( F, iridescenceF,  surf.iridescence );

		// PDF
		// See 14.1.1 Microfacet BxDFs in https://www.pbr-book.org/
		float incidentTheta = acos( wo.z );
		float G = ggxShadowMaskG2( wi, wo, roughness );
		float D = ggxDistribution( wh, roughness );
		float G1 = ggxShadowMaskG1( incidentTheta, roughness );
		float ggxPdf = D * G1 * max( 0.0, abs( dot( wo, wh ) ) ) / abs ( wo.z );

		throughput = wi.z * heroWeightFromRgb( F, heroWavelength ) * G * D / ( 4.0 * abs( wi.z * wo.z ) );
		if ( surf.thinFilm && surf.thinFilmEnabled > 0.5 ) {
			vec2 rt = thinFilmTMM( surf.materialIndex, int( surf.thinFilmLayerCount ), heroWavelength, surf.ior );
			throughput *= max( rt.x, 1e-4 );
		}
		return ggxPdf / ( 4.0 * dot( wo, wh ) );

	}

	vec3 specularDirection( vec3 wo, SurfaceRecord surf ) {

		// sample ggx vndf distribution which gives a new normal
		float roughness = surf.filteredRoughness;
		vec3 halfVector = ggxDirection(
			wo,
			vec2( roughness ),
			rand2( 12 )
		);

		// apply to new ray by reflecting off the new normal
		return - reflect( wo, halfVector );

	}


	// transmission
	/*
	float transmissionEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, inout vec3 color ) {

		// See section 4.2 in https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf

		float filteredRoughness = surf.filteredRoughness;
		float eta = surf.eta;
		bool frontFace = surf.frontFace;
		bool thinFilm = surf.thinFilm;

		color = surf.transmission * surf.color;

		float denom = pow( eta * dot( wi, wh ) + dot( wo, wh ), 2.0 );
		return ggxPDF( wo, wh, filteredRoughness ) / denom;

	}

	vec3 transmissionDirection( vec3 wo, SurfaceRecord surf ) {

		float filteredRoughness = surf.filteredRoughness;
		float eta = surf.eta;
		bool frontFace = surf.frontFace;

		// sample ggx vndf distribution which gives a new normal
		vec3 halfVector = ggxDirection(
			wo,
			vec2( filteredRoughness ),
			rand2( 13 )
		);

		vec3 lightDirection = refract( normalize( - wo ), halfVector, eta );
		if ( surf.thinFilm ) {

			lightDirection = - refract( normalize( - lightDirection ), - vec3( 0.0, 0.0, 1.0 ), 1.0 / eta );

		}

		return normalize( lightDirection );

	}
	*/

	// TODO: This is just using a basic cosine-weighted specular distribution with an
	// incorrect PDF value at the moment. Update it to correctly use a GGX distribution
	float transmissionEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, float heroWavelength, inout float throughput ) {

		throughput = surf.transmission * heroWeightFromRgb( surf.color, heroWavelength );
		if ( surf.thinFilm && surf.thinFilmEnabled > 0.5 ) {
			vec2 rt = thinFilmTMM( surf.materialIndex, int( surf.thinFilmLayerCount ), heroWavelength, surf.ior );
			throughput *= max( rt.y, 1e-4 );
		}

		// PDF
		// float F = evaluateFresnelWeight( dot( wo, wh ), surf.eta, surf.f0 );
		// float F = disneyFresnel( wo, wi, wh, surf.f0, surf.eta, surf.metalness );
		// if ( F >= 1.0 ) {

		// 	return 0.0;

		// }

		// return 1.0 / ( 1.0 - F );

		// reverted to previous to transmission. The above was causing black pixels
		float eta = surf.eta;
		float f0 = surf.f0;
		float cosTheta = min( wo.z, 1.0 );
		float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );
		float reflectance = schlickFresnel( cosTheta, f0 );
		bool cannotRefract = eta * sinTheta > 1.0;
		if ( cannotRefract ) {

			return 0.0;

		}

		return 1.0 / ( 1.0 - reflectance );

	}

	vec3 transmissionDirection( vec3 wo, SurfaceRecord surf ) {

		float roughness = surf.filteredRoughness;
		float eta = surf.eta;
		vec3 halfVector = normalize( vec3( 0.0, 0.0, 1.0 ) + sampleSphere( rand2( 13 ) ) * roughness );
		vec3 lightDirection = refract( normalize( - wo ), halfVector, eta );

		if ( surf.thinFilm ) {

			lightDirection = - refract( normalize( - lightDirection ), - vec3( 0.0, 0.0, 1.0 ), 1.0 / eta );

		}
		return normalize( lightDirection );

	}

	// ── Sprint 12: Cauchy IOR at arbitrary wavelength ────────────────────────────
	//
	// cauchyIORatLambda: evaluate IOR at a given wavelength using the three-term Cauchy formula.
	// GLSL mirror of @vitrum/shared-samplers/src/cauchyIor.ts::cauchyIOR.
	//
	// Parameters: lambdaNm in nm; A, B, C in µm units (Sprint 12 coefficient form).
	//   n(λ) = A + B/λ² + C/λ⁴    (λ in µm)
	//
	// This function is the Sprint 12 replacement for Sprint 8's per-channel Cauchy approach.
	// It is called at the hero wavelength sampled from sampleHeroWavelength in the main loop.
	//
	// New uniforms: iorCauchyA, iorCauchyB, iorCauchyC (see PhysicalPathTracingMaterial.js).
	// Sprint 8 uniforms (u_ior0, u_dispersionStrength) are kept for backward compatibility.
	//
	// Sprint 12 payload restructure note:
	// dispersionTransmissionDirection() now consumes the payload-carried hero wavelength
	// and Cauchy A/B/C uniforms. Remaining scalarisation work is tracked in SPRINT_12_GAPS.md.
	float cauchyIORatLambda( float lambdaNm, float A, float B, float C ) {
		float lambdaUm = lambdaNm * 0.001;  // nm → µm
		float lam2 = lambdaUm * lambdaUm;
		float lam4 = lam2 * lam2;
		// Fast path: skip C term when near-zero to save one division.
		if ( abs( C ) < 1e-8 ) return A + B / lam2;
		return A + B / lam2 + C / lam4;
	}

	// Sprint 12: Jakob+Hanika spectral reflectance weight at arbitrary hero wavelength.
	// When the payload carries a scalar hero wavelength (post-restructure), this replaces
	// the per-channel evalSpectrum calls in dispersionTransmissionDirection.
	float evalSpectrumAtHero( float lambdaNm ) {
		return evalSpectrum( u_jakobCoeffs, lambdaNm );
	}

	// ── Sprint 8: Chromatic dispersion via Cauchy formula + Jakob+Hanika rider ──
	//
	// evalSpectrum: 6-instruction sigmoid polynomial evaluation.
	// GLSL mirror of @vitrum/shared-samplers/src/jakobHanika.ts::evaluateSpectrum.
	// sigmoid(x) = 0.5 + x * inversesqrt(1 + x²) * 0.5
	//
	// coeffs = (c0, c1, c2) from host-side rgbToSpectralCoefficients.
	// lambda  = wavelength in nm.
	float evalSpectrum( vec3 coeffs, float lambda ) {
		float x = coeffs.x + coeffs.y * lambda + coeffs.z * lambda * lambda;
		return 0.5 + x * inversesqrt( 1.0 + x * x ) * 0.5;
	}

	// Sprint 12: dielectric transmission at the path's hero wavelength.
	// Uses the payload-carried wavelength and Cauchy A/B/C uniforms.
	vec3 dispersionTransmissionDirection( vec3 wo, SurfaceRecord surf, float wavelengthNm ) {
		float chosenIor = cauchyIORatLambda( wavelengthNm, surf.ior, surf.dispersionStrength * 1e-6, 0.0 );

		// Refract using the hero-wavelength IOR (front-face: air→glass = 1/ior).
		bool frontFace = surf.frontFace;
		float eta = frontFace ? 1.0 / chosenIor : chosenIor;

		float roughness = surf.filteredRoughness;
		vec3 halfVector = normalize( vec3( 0.0, 0.0, 1.0 ) + sampleSphere( rand2( 13 ) ) * roughness );
		vec3 lightDirection = refract( normalize( - wo ), halfVector, eta );

		if ( surf.thinFilm ) {
			lightDirection = - refract( normalize( - lightDirection ), - vec3( 0.0, 0.0, 1.0 ), 1.0 / eta );
		}
		return normalize( lightDirection );

	}

	// clearcoat
	float clearcoatEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, float heroWavelength, inout float throughput ) {

		float ior = 1.5;
		float f0 = iorRatioToF0( ior );
		bool frontFace = surf.frontFace;
		float roughness = surf.filteredClearcoatRoughness;

		float eta = frontFace ? 1.0 / ior : ior;
		float G = ggxShadowMaskG2( wi, wo, roughness );
		float D = ggxDistribution( wh, roughness );
		float F = schlickFresnel( dot( wi, wh ), f0 );

		float fClearcoat = F * D * G / ( 4.0 * abs( wi.z * wo.z ) );
		throughput = throughput * ( 1.0 - surf.clearcoat * F ) + fClearcoat * surf.clearcoat * wi.z;

		// PDF
		// See equation (27) in http://jcgt.org/published/0003/02/03/
		return ggxPDF( wo, wh, roughness ) / ( 4.0 * dot( wi, wh ) );

	}

	vec3 clearcoatDirection( vec3 wo, SurfaceRecord surf ) {

		// sample ggx vndf distribution which gives a new normal
		float roughness = surf.filteredClearcoatRoughness;
		vec3 halfVector = ggxDirection(
			wo,
			vec2( roughness ),
			rand2( 14 )
		);

		// apply to new ray by reflecting off the new normal
		return - reflect( wo, halfVector );

	}

	// sheen
	float sheenEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, float heroWavelength ) {

		float cosThetaO = saturateCos( wo.z );
		float cosThetaI = saturateCos( wi.z );
		float cosThetaH = wh.z;

		float D = velvetD( cosThetaH, surf.sheenRoughness );
		float G = velvetG( cosThetaO, cosThetaI, surf.sheenRoughness );

		// See equation (1) in http://www.aconty.com/pdf/s2017_pbs_imageworks_sheen.pdf
		float sheen = heroWeightFromRgb( surf.sheenColor, heroWavelength );
		sheen *= D * G / ( 4.0 * abs( cosThetaO * cosThetaI ) );
		sheen *= wi.z;

		return sheen;

	}

	// bsdf
	void getLobeWeights(
		vec3 wo, vec3 wi, vec3 wh, vec3 clearcoatWo, SurfaceRecord surf,
		inout float diffuseWeight, inout float specularWeight, inout float transmissionWeight, inout float clearcoatWeight
	) {

		float metalness = surf.metalness;
		float transmission = surf.transmission;
		// float fEstimate = evaluateFresnelWeight( dot( wo, wh ), surf.eta, surf.f0 );
		float fEstimate = disneyFresnel( wo, wi, wh, surf.f0, surf.eta, surf.metalness );

		float transSpecularProb = mix( max( 0.25, fEstimate ), 1.0, metalness );
		float diffSpecularProb = 0.5 + 0.5 * metalness;

		diffuseWeight = ( 1.0 - transmission ) * ( 1.0 - diffSpecularProb );
		specularWeight = transmission * transSpecularProb + ( 1.0 - transmission ) * diffSpecularProb;
		transmissionWeight = transmission * ( 1.0 - transSpecularProb );
		clearcoatWeight = surf.clearcoat * schlickFresnel( clearcoatWo.z, 0.04 );

		float totalWeight = diffuseWeight + specularWeight + transmissionWeight + clearcoatWeight;
		diffuseWeight /= totalWeight;
		specularWeight /= totalWeight;
		transmissionWeight /= totalWeight;
		clearcoatWeight /= totalWeight;
	}

	float bsdfEval(
		vec3 wo, vec3 clearcoatWo, vec3 wi, vec3 clearcoatWi, SurfaceRecord surf,
		float heroWavelength,
		float diffuseWeight, float specularWeight, float transmissionWeight, float clearcoatWeight, inout float specularPdf, inout float throughput
	) {

		float metalness = surf.metalness;
		float transmission = surf.transmission;

		float spdf = 0.0;
		float dpdf = 0.0;
		float tpdf = 0.0;
		float cpdf = 0.0;
		throughput = 0.0;

		vec3 halfVector = getHalfVector( wi, wo, surf.eta );

		// diffuse
		if ( diffuseWeight > 0.0 && wi.z > 0.0 ) {

			dpdf = diffuseEval( wo, wi, halfVector, surf, heroWavelength, throughput );
			throughput *= 1.0 - surf.transmission;

		}

		// ggx specular
		if ( specularWeight > 0.0 && wi.z > 0.0 ) {

			float outThroughput = 0.0;
			spdf = specularEval( wo, wi, getHalfVector( wi, wo ), surf, heroWavelength, outThroughput );
			throughput += outThroughput;

		}

		// transmission
		if ( transmissionWeight > 0.0 && wi.z < 0.0 ) {

			tpdf = transmissionEval( wo, wi, halfVector, surf, heroWavelength, throughput );

		}

		// sheen
		throughput *= mix( 1.0, sheenAlbedoScaling( wo, wi, surf ), surf.sheen );
		throughput += sheenEval( wo, wi, halfVector, surf, heroWavelength ) * surf.sheen;

		// clearcoat
		if ( clearcoatWi.z >= 0.0 && clearcoatWeight > 0.0 ) {

			vec3 clearcoatHalfVector = getHalfVector( clearcoatWo, clearcoatWi );
			cpdf = clearcoatEval( clearcoatWo, clearcoatWi, clearcoatHalfVector, surf, heroWavelength, throughput );

		}

		// RFE-03: apply selected front/back layer absorption exactly once in BSDF flow.
		throughput *= activeLayerWeight( surf, heroWavelength );

		float pdf =
			dpdf * diffuseWeight
			+ spdf * specularWeight
			+ tpdf * transmissionWeight
			+ cpdf * clearcoatWeight;

		// retrieve specular rays for the shadows flag
		specularPdf = spdf * specularWeight + cpdf * clearcoatWeight;

		return pdf;

	}

	float bsdfResult( vec3 worldWo, vec3 worldWi, SurfaceRecord surf, float heroWavelength, inout float throughput ) {

		if ( surf.volumeParticle ) {

			throughput = heroWeightFromRgb( surf.color, heroWavelength ) / ( 4.0 * PI );
			return 1.0 / ( 4.0 * PI );

		}

		vec3 wo = normalize( surf.normalInvBasis * worldWo );
		vec3 wi = normalize( surf.normalInvBasis * worldWi );

		vec3 clearcoatWo = normalize( surf.clearcoatInvBasis * worldWo );
		vec3 clearcoatWi = normalize( surf.clearcoatInvBasis * worldWi );

		vec3 wh = getHalfVector( wo, wi, surf.eta );
		float diffuseWeight;
		float specularWeight;
		float transmissionWeight;
		float clearcoatWeight;
		getLobeWeights( wo, wi, wh, clearcoatWo, surf, diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight );

		float specularPdf;
		return bsdfEval(
			wo, clearcoatWo, wi, clearcoatWi, surf, heroWavelength,
			diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight, specularPdf, throughput
		);

	}

	// Sprint 7: SSS single scatter via HG phase function.
	// Called when a ray exits the back face of a TRANSLUCENT material
	// (gated by u_sssSigmaT > 0 — see PhysicalPathTracingMaterial.js uniforms).
	// The scatter position is sampled from an exponential distribution along
	// the refracted direction; the scattered direction is sampled from HG.
	// Mirrors @vitrum/shared-samplers/src/hgPhase.ts::sampleHG.
	ScatterRecord sssSample( vec3 worldWo, SurfaceRecord surf, float heroWavelength ) {

		float tScatter = sampleExponential( rand( 17 ), surf.sssSigmaT, 1e6 );
		float beerLambert = exp( - surf.sssSigmaT * tScatter );

		vec3 rd = normalize( - worldWo ); // refracted direction approximation
		vec3 scatterDir = sampleHG_glsl( rand( 18 ), rand( 19 ), surf.sssAnisotropyG, rd );

		ScatterRecord sssRec;
		sssRec.pdf = hg_phase( dot( rd, scatterDir ), surf.sssAnisotropyG );
		sssRec.specularPdf = 0.0;
		sssRec.direction = scatterDir;
		sssRec.throughput = heroWeightFromRgb( surf.sssAlbedo, heroWavelength ) * beerLambert;
		return sssRec;

	}

	ScatterRecord bsdfSample( vec3 worldWo, SurfaceRecord surf, float heroWavelength ) {

		if ( surf.volumeParticle ) {

			ScatterRecord sampleRec;
			sampleRec.specularPdf = 0.0;
			sampleRec.pdf = 1.0 / ( 4.0 * PI );
			sampleRec.direction = sampleSphere( rand2( 16 ) );
			sampleRec.throughput = heroWeightFromRgb( surf.color, heroWavelength ) / ( 4.0 * PI );
			return sampleRec;

		}

		vec3 wo = normalize( surf.normalInvBasis * worldWo );
		vec3 clearcoatWo = normalize( surf.clearcoatInvBasis * worldWo );
		mat3 normalBasis = surf.normalBasis;
		mat3 invBasis = surf.normalInvBasis;
		mat3 clearcoatNormalBasis = surf.clearcoatBasis;
		mat3 clearcoatInvBasis = surf.clearcoatInvBasis;

		float diffuseWeight;
		float specularWeight;
		float transmissionWeight;
		float clearcoatWeight;
		// using normal and basically-reflected ray since we don't have proper half vector here
		getLobeWeights( wo, wo, vec3( 0, 0, 1 ), clearcoatWo, surf, diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight );

		float pdf[4];
		pdf[0] = diffuseWeight;
		pdf[1] = specularWeight;
		pdf[2] = transmissionWeight;
		pdf[3] = clearcoatWeight;

		float cdf[4];
		cdf[0] = pdf[0];
		cdf[1] = pdf[1] + cdf[0];
		cdf[2] = pdf[2] + cdf[1];
		cdf[3] = pdf[3] + cdf[2];

		if( cdf[3] != 0.0 ) {

			float invMaxCdf = 1.0 / cdf[3];
			cdf[0] *= invMaxCdf;
			cdf[1] *= invMaxCdf;
			cdf[2] *= invMaxCdf;
			cdf[3] *= invMaxCdf;

		} else {

			cdf[0] = 1.0;
			cdf[1] = 0.0;
			cdf[2] = 0.0;
			cdf[3] = 0.0;

		}

		vec3 wi;
		vec3 clearcoatWi;

		float r = rand( 15 );
		if ( r <= cdf[0] ) { // diffuse

			wi = diffuseDirection( wo, surf );
			clearcoatWi = normalize( clearcoatInvBasis * normalize( normalBasis * wi ) );

		} else if ( r <= cdf[1] ) { // specular

			wi = specularDirection( wo, surf );
			clearcoatWi = normalize( clearcoatInvBasis * normalize( normalBasis * wi ) );

		} else if ( r <= cdf[2] ) { // transmission / refraction

			// Sprint 12: hero-wavelength IOR path when dispersion is enabled.
			if ( surf.dispersionStrength > 1e-4 ) {
				wi = dispersionTransmissionDirection( wo, surf, heroWavelength );
				clearcoatWi = normalize( clearcoatInvBasis * normalize( normalBasis * wi ) );
			} else {
				wi = transmissionDirection( wo, surf );
				clearcoatWi = normalize( clearcoatInvBasis * normalize( normalBasis * wi ) );
			}

		} else if ( r <= cdf[3] ) { // clearcoat

			clearcoatWi = clearcoatDirection( clearcoatWo, surf );
			wi = normalize( invBasis * normalize( clearcoatNormalBasis * clearcoatWi ) );

		}

		ScatterRecord result;
		result.pdf = bsdfEval(
			wo, clearcoatWo, wi, clearcoatWi, surf, heroWavelength,
			diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight, result.specularPdf, result.throughput
		);
		result.direction = normalize( surf.normalBasis * wi );

		return result;

	}

`;
