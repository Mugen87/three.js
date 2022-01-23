import { LinearEncoding, NoToneMapping, sRGBEncoding, LinearToneMapping, ReinhardToneMapping, CineonToneMapping, ACESFilmicToneMapping, CustomToneMapping, HalfFloatType } from '../../constants.js';
import { BufferGeometry } from '../../core/BufferGeometry.js';
import { Float32BufferAttribute } from '../../core/BufferAttribute.js';
import { OrthographicCamera } from '../../cameras/OrthographicCamera.js';
import { Mesh } from '../../objects/Mesh.js';
import { ShaderMaterial } from '../../materials/ShaderMaterial.js';
import { Vector2 } from '../../math/Vector2.js';
import { WebGLRenderTarget } from '../WebGLRenderTarget.js';
import { WebGLMultisampleRenderTarget } from '../WebGLMultisampleRenderTarget.js';
import { cloneUniforms } from '../shaders/UniformsUtils.js';

function WebGLFXManager( renderer, extensions, capabilities, antialias ) {

	let renderTarget = null;
	const resolution = new Vector2();

	let camera = null;
	let geometry = null;
	let material = null;

	let toneMapping = NoToneMapping;
	let outputEncoding = LinearEncoding;

	let fullscreenQuad = null;

	function prepare() {


		if ( renderTarget === null ) {

			const needsAntialias = antialias === true && capabilities.isWebGL2 === true;
			const renderTargetType = needsAntialias ? WebGLMultisampleRenderTarget : WebGLRenderTarget;

			renderTarget = new renderTargetType( 1024, 1024, {
				type: HalfFloatType
			} );

			camera = new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

			geometry = new BufferGeometry();
			geometry.setAttribute( 'position', new Float32BufferAttribute( [ - 1, 3, 0, - 1, - 1, 0, 3, - 1, 0 ], 3 ) );
			geometry.setAttribute( 'uv', new Float32BufferAttribute( [ 0, 2, 0, 0, 2, 0 ], 2 ) );

			material = new ShaderMaterial( {
				defines: {
					LINEAR: '',
					NO_TONEMAPPING: ''
				},
				name: 'FXShader',
				fragmentShader: FXShader.fragmentShader,
				vertexShader: FXShader.vertexShader,
				uniforms: cloneUniforms( FXShader.uniforms ),
			} );

			fullscreenQuad = new Mesh( geometry, material );

		}

		renderer.getDrawingBufferSize( resolution );

		renderTarget.setSize( resolution.width, resolution.height );

		renderer.setRenderTarget( renderTarget );


	}

	function render() {

		material.uniforms.tDiffuse.value = renderTarget.texture;
		material.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;

		// update defines if necessary

		if ( toneMapping !== renderer.toneMapping || outputEncoding !== renderer.outputEncoding ) {

			material.defines = {};

			if ( toneMapping !== renderer.toneMapping ) {

				switch ( renderer.toneMapping ) {

					case LinearToneMapping:
						material.defines.LINEAR_TONE_MAPPING = '';
						break;

					case ReinhardToneMapping:
						material.defines.REINHARD_TONE_MAPPING = '';
						break;

					case CineonToneMapping:
						material.defines.CINEON_TONE_MAPPING = '';
						break;

					case ACESFilmicToneMapping:
						material.defines.ACES_TONE_MAPPING = '';
						break;

					case CustomToneMapping:
						material.defines.CUSTOM_TONE_MAPPING = '';
						break;

					default:
						material.defines.NO_TONE_MAPPING = '';

				}

				toneMapping = renderer.toneMapping;

				material.needsUpdate;

			}

			if ( outputEncoding !== renderer.outputEncoding ) {

				switch ( renderer.outputEncoding ) {

					case sRGBEncoding:
						material.defines.SRGB = '';
						break;

					default:
						material.defines.LINEAR = '';

				}

				outputEncoding = renderer.outputEncoding;

				material.needsUpdate;

			}

		}

		// save current renderer settings

		const currentOutputEncoding = renderer.outputEncoding;
		const currentToneMapping = renderer.toneMapping;
		const currentXrEnabled = renderer.xr.enabled;
		const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;

		// render

		renderer.outputEncoding = LinearEncoding;
		renderer.toneMapping = NoToneMapping;
		renderer.xr.enabled = false;
		renderer.shadowMap.autoUpdate = false;

		renderer.setRenderTarget( null );
		renderer.render( fullscreenQuad, camera );

		// restore

		renderer.outputEncoding = currentOutputEncoding;
		renderer.toneMapping = currentToneMapping;
		renderer.xr.enabled = currentXrEnabled;
		renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;

	}


	function dispose() {

		if ( renderTarget !== null ) {

			renderTarget.dispose();
			geometry.dispose();
			material.dispose();

		}

	}

	return {
		prepare: prepare,
		render: render,
		dispose: dispose
	};

}

const FXShader = {

	uniforms: {

		'tDiffuse': { value: null },
		'toneMappingExposure': { value: 1 }

	},

	vertexShader: /* glsl */`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,

	fragmentShader: /* glsl */`

		uniform sampler2D tDiffuse;

		#include <encodings_pars_fragment>
		#include <tonemapping_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#if defined( LINEAR_TONE_MAPPING )

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( ReinhardToneMapping )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );


			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = OptimizedCineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#endif

			// color space conversion

			#if defined( SRGB )

				gl_FragColor = LinearTosRGB( gl_FragColor );

			#endif

		}`

};

export { WebGLFXManager };
