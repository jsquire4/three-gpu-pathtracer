// spectral_accumulator.glsl.js — Sprint 12 hero-wavelength spectral accumulator.
//
// Implements CIE 1931 2-degree standard observer CMF sampling and XYZ → linear
// sRGB conversion for the hero-wavelength spectral path tracing kernel.
//
// GLSL mirror of @vitrum/shared-samplers/src/cieCmf.ts and wavelengthSampling.ts.
//
// Technique: Fascione et al. "Hero Wavelength Spectral Sampling", EGSR 2015.
//
// At each path termination the scalar throughput at the hero wavelength is
// converted to an RGB radiance contribution via:
//   XYZ = [x̄(λ), ȳ(λ), z̄(λ)] × throughput / (pdfLambda × ∫Y dλ)
//   RGB = M_XYZ_to_sRGB × XYZ
// where M_XYZ_to_sRGB is the Bradford-adapted D65 matrix (IEC 61966-2-1:1999).
//
// CMF tables are uploaded as uniform arrays (81 entries × 3 channels).
// The Y-CMF CDF (82 entries) is used for importance-sampling sampleHeroWavelength.
//
// New uniforms (added to PhysicalPathTracingMaterial.js in this sprint):
//   uCmfX[81]      — CIE x̄(λ) table (380–780 nm at 5 nm steps)
//   uCmfY[81]      — CIE ȳ(λ) table
//   uCmfZ[81]      — CIE z̄(λ) table
//   uYCmfCdf[82]   — normalised CDF of ȳ(λ) for importance sampling
//   uYCmfIntegral  — ∫ Y dλ (nm), ≈ 106.857; PDF normalisation constant
//
// References:
//   CIE 015:2018 Colorimetry, 4th edition.
//   IEC 61966-2-1:1999 Annex F (Bradford-adapted D65 XYZ→sRGB matrix).
//   plan/sprint-12-pt-fork-patch.md §2.4 (spectral accumulator spec).

export const spectral_accumulator = /* glsl */`

	// Sprint 12 CMF uniform arrays.
	// Populated by the host from @vitrum/shared-samplers CIE_X/Y/Z_TABLE.
	// 81 entries, 380–780 nm at 5 nm steps.
	uniform float uCmfX[81];
	uniform float uCmfY[81];
	uniform float uCmfZ[81];

	// Y-CMF CDF for hero wavelength importance sampling (82 entries).
	// uYCmfCdf[0] = 0, uYCmfCdf[81] = 1.
	uniform float uYCmfCdf[82];

	// Integral of Y CMF over [380, 780] nm (≈ 106.857 nm).
	uniform float uYCmfIntegral;

	// Non-zero enables experimental hero-wavelength RGB reconstruction. The
	// default preview path stays RGB-stable because single-wavelength display
	// has very high chroma variance at low SPP.
	uniform int uSpectralRendering;

	// ── CMF linear interpolation ───────────────────────────────────────────────

	// Linear interpolation helper for a 81-entry CMF table at 5 nm steps.
	// Returns 0 for wavelengths outside [380, 780] nm (mirror of sampleTable in cieCmf.ts).
	float sampleCmfTable81( float table[81], float lambda ) {
		if ( lambda < 380.0 || lambda > 780.0 ) return 0.0;
		float f = ( lambda - 380.0 ) / 5.0;
		int lo = int( f );
		int hi = min( lo + 1, 80 );
		float t = f - float( lo );
		return table[ lo ] + t * ( table[ hi ] - table[ lo ] );
	}

	// Sample CIE x̄(λ) at an arbitrary wavelength (linear interpolation).
	float sampleCmfX( float lambda ) { return sampleCmfTable81( uCmfX, lambda ); }

	// Sample CIE ȳ(λ) at an arbitrary wavelength (linear interpolation).
	float sampleCmfY( float lambda ) { return sampleCmfTable81( uCmfY, lambda ); }

	// Sample CIE z̄(λ) at an arbitrary wavelength (linear interpolation).
	float sampleCmfZ( float lambda ) { return sampleCmfTable81( uCmfZ, lambda ); }

	// ── Hero wavelength importance sampling ────────────────────────────────────

	// Sample a hero wavelength from pdf(λ) ∝ Y(λ) (luminous efficiency).
	// Returns wavelength in [380, 780] nm; outputs pdf in nm⁻¹.
	// GLSL mirror of @vitrum/shared-samplers/src/wavelengthSampling.ts::sampleHeroWavelength.
	//
	// CDF inversion: binary search on the 82-entry uYCmfCdf array.
	float sampleHeroWavelength( float u, out float pdf ) {
		// Clamp u to valid range.
		float uClamped = clamp( u, 0.0, 1.0 - 1e-7 );

		// Binary search over CDF[0..81] (82 entries).
		int lo = 0;
		int hi = 80;
		for ( int iter = 0; iter < 7; iter ++ ) {  // 7 iterations covers 2^7 = 128 > 82
			int mid = ( lo + hi ) / 2;
			if ( uYCmfCdf[ mid + 1 ] <= uClamped ) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}

		// Linear interpolation within the segment.
		float cdfLo = uYCmfCdf[ lo ];
		float cdfHi = uYCmfCdf[ lo + 1 ];
		float yLo = uCmfY[ lo ];
		float yHi = ( lo < 80 ) ? uCmfY[ lo + 1 ] : 0.0;

		float t = ( cdfHi > cdfLo ) ? ( uClamped - cdfLo ) / ( cdfHi - cdfLo ) : 0.0;
		float lambda = float( 380 + lo * 5 ) + t * 5.0;
		lambda = clamp( lambda, 380.0, 780.0 );

		// pdf(λ) = Y(λ) / ∫Y(λ)dλ
		float yAtLambda = yLo + t * ( yHi - yLo );
		pdf = ( uYCmfIntegral > 0.0 ) ? yAtLambda / uYCmfIntegral : 0.0;
		return lambda;
	}

	// ── Spectral → RGB accumulator ─────────────────────────────────────────────

	// Convert a hero-wavelength path result to linear sRGB.
// For path with hero wavelength lambda, scalar throughput, and wavelength PDF:
//   XYZ = [x̄(λ), ȳ(λ), z̄(λ)] × throughput / (pdfLambda × ∫Y dλ)
	//   RGB = M_D65 × XYZ
	//
	// The Bradford-adapted D65 XYZ → linear sRGB matrix (IEC 61966-2-1:1999):
	//   R =  3.2404542·X − 1.5371385·Y − 0.4985314·Z
	//   G = −0.9692660·X + 1.8760108·Y + 0.0415560·Z
	//   B =  0.0556434·X − 0.2040259·Y + 1.0572252·Z
	//
	// GLSL mirror of @vitrum/shared-samplers/src/wavelengthSampling.ts::wavelengthToRGB.
	vec3 wavelengthToRGB( float lambda, float throughput, float pdfLambda ) {
		if ( uSpectralRendering == 0 ) return vec3( throughput );
		if ( pdfLambda <= 0.0 ) return vec3( 0.0 );

		float x = sampleCmfX( lambda );
		float y = sampleCmfY( lambda );
		float z = sampleCmfZ( lambda );

		float weight = throughput / max( pdfLambda * uYCmfIntegral, 1e-6 );
		vec3 xyz = vec3( x, y, z ) * weight;

		// XYZ → linear sRGB (Bradford-adapted D65 matrix, IEC 61966-2-1:1999)
		vec3 rgb;
		rgb.r =  3.2404542 * xyz.x - 1.5371385 * xyz.y - 0.4985314 * xyz.z;
		rgb.g = -0.9692660 * xyz.x + 1.8760108 * xyz.y + 0.0415560 * xyz.z;
		rgb.b =  0.0556434 * xyz.x - 0.2040259 * xyz.y + 1.0572252 * xyz.z;

		return rgb;
	}

`;
