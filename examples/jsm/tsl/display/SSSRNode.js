import { HalfFloatType, FloatType, RedFormat, NearestFilter, RenderTarget, Vector2, Box2, RendererUtils, QuadMesh, TempNode, NodeMaterial, NodeUpdateType } from 'three/webgpu';
import { texture, textureLoad, reference, viewZToPerspectiveDepth, logarithmicDepthToViewZ, perspectiveDepthToViewZ, orthographicDepthToViewZ, getViewPosition, float, int, ivec2, vec2, vec3, vec4, uv, uniform, Fn, If, Loop, Break, select, min, max, abs, floor, exp2, normalize, cross, reflect, dot, sqrt, inversesqrt, sin, cos, PI, passTexture, nodeObject, screenCoordinate, interleavedGradientNoise } from 'three/tsl';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();
const _copyRegion = /*@__PURE__*/ new Box2();
let _rendererState;

const HIZ_MIP_COUNT = 8;

/**
 * Post processing node for computing Stochastic Screen Space Reflections (SSSR).
 *
 * This is a simplified port of AMD FidelityFX Stochastic Screen Space Reflections
 * ({@link https://github.com/GPUOpen-Effects/FidelityFX-SSSR}). Compared to the
 * traditional SSR implementation in `SSRNode`, SSSR uses:
 *
 * - **Hierarchical-Z (HiZ) ray marching**: a min-depth mip pyramid is built from the
 *   scene depth, and the ray can skip over empty tiles at coarser mips — enabling
 *   much longer rays at a fixed iteration budget.
 * - **GGX VNDF importance sampling**: a single stochastic reflection direction is
 *   sampled per pixel based on the material's roughness, producing physically based
 *   glossy reflections without requiring a separate blur pass.
 *
 * Because the output is stochastic and inherently noisy, SSSR is best combined with
 * temporal filtering (e.g. `TRAANode`) which denoises by accumulating samples over
 * multiple frames.
 *
 * Reference: {@link https://github.com/GPUOpen-Effects/FidelityFX-SSSR}
 *
 * @augments TempNode
 * @three_import import { sssr } from 'three/addons/tsl/display/SSSRNode.js';
 */
class SSSRNode extends TempNode {

	static get type() {

		return 'SSSRNode';

	}

	/**
	 * Constructs a new SSSR node.
	 *
	 * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
	 * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
	 * @param {Node<vec3>} normalNode - A node that represents the beauty pass's normals (view space).
	 * @param {Node<float>} metalnessNode - A node that represents the beauty pass's metalness.
	 * @param {Node<float>} roughnessNode - A node that represents the beauty pass's roughness.
	 * @param {?Camera} [camera=null] - The camera the scene is rendered with.
	 */
	constructor( colorNode, depthNode, normalNode, metalnessNode, roughnessNode, camera = null ) {

		super( 'vec4' );

		/**
		 * The node that represents the beauty pass.
		 *
		 * @type {Node<vec4>}
		 */
		this.colorNode = colorNode;

		/**
		 * A node that represents the beauty pass's depth.
		 *
		 * @type {Node<float>}
		 */
		this.depthNode = depthNode;

		/**
		 * A node that represents the beauty pass's normals (view space).
		 *
		 * @type {Node<vec3>}
		 */
		this.normalNode = normalNode;

		/**
		 * A node that represents the beauty pass's metalness.
		 *
		 * @type {Node<float>}
		 */
		this.metalnessNode = metalnessNode;

		/**
		 * A node that represents the beauty pass's roughness (perceptual).
		 *
		 * @type {Node<float>}
		 */
		this.roughnessNode = roughnessNode;

		/**
		 * The resolution scale. Valid values are in the range
		 * `[0,1]`. `1` means best quality but also results in
		 * more computational overhead. Setting to `0.5` means
		 * the effect is computed in half-resolution.
		 *
		 * @type {number}
		 * @default 1
		 */
		this.resolutionScale = 1;

		/**
		 * The `updateBeforeType` is set to `NodeUpdateType.FRAME` since the node renders
		 * its effect once per frame in `updateBefore()`.
		 *
		 * @type {string}
		 * @default 'frame'
		 */
		this.updateBeforeType = NodeUpdateType.FRAME;

		/**
		 * Characteristic view-space distance used for reflection attenuation. Hits
		 * farther than this distance from the reflecting surface fade linearly to
		 * zero. This is a soft fade, not a hard cut-off.
		 *
		 * @type {UniformNode<float>}
		 */
		this.maxDistance = uniform( 10 );

		/**
		 * View-space thickness assumed for the depth buffer during hit validation.
		 * Hits beyond this thickness from the surface they intersect are faded out.
		 *
		 * @type {UniformNode<float>}
		 */
		this.thickness = uniform( 0.1 );

		/**
		 * Global opacity multiplier for the reflection output.
		 *
		 * @type {UniformNode<float>}
		 */
		this.opacity = uniform( 1 );

		/**
		 * Maximum number of iterations the HiZ ray marcher is allowed to perform per
		 * pixel. Higher values allow longer rays but are more expensive.
		 *
		 * @type {UniformNode<int>}
		 */
		this.maxIterations = uniform( 64, 'int' );

		/**
		 * The finest (lowest) mip level the ray marcher is allowed to descend to.
		 * Raising this value trades hit precision for performance. Typical values
		 * are `0` (full precision) or `1`.
		 *
		 * @type {UniformNode<int>}
		 */
		this.mostDetailedMip = uniform( 0, 'int' );

		//

		if ( camera === null ) {

			if ( this.colorNode.passNode && this.colorNode.passNode.isPassNode === true ) {

				camera = this.colorNode.passNode.camera;

			} else {

				throw new Error( 'THREE.TSL: No camera found. sssr() requires a camera.' );

			}

		}

		/**
		 * The camera the scene is rendered with.
		 *
		 * @type {Camera}
		 */
		this.camera = camera;

		/**
		 * Represents the projection matrix of the scene's camera.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraProjectionMatrix = uniform( camera.projectionMatrix );

		/**
		 * Represents the inverse projection matrix of the scene's camera.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraProjectionMatrixInverse = uniform( camera.projectionMatrixInverse );

		/**
		 * Represents the near value of the scene's camera.
		 *
		 * @private
		 * @type {ReferenceNode<float>}
		 */
		this._cameraNear = reference( 'near', 'float', camera );

		/**
		 * Represents the far value of the scene's camera.
		 *
		 * @private
		 * @type {ReferenceNode<float>}
		 */
		this._cameraFar = reference( 'far', 'float', camera );

		/**
		 * The resolution of the pass.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._resolution = uniform( new Vector2() );

		/**
		 * Source mip level used by the HiZ downsample pass.
		 *
		 * @private
		 * @type {UniformNode<int>}
		 */
		this._hizSourceMip = uniform( 0, 'int' );

		/**
		 * Frame counter used as a temporal decorrelation seed for the stochastic
		 * reflection direction.
		 *
		 * @private
		 * @type {UniformNode<float>}
		 */
		this._frameIndex = uniform( 0 );

		/**
		 * The render target that holds the final HiZ min-depth mip pyramid.
		 *
		 * @private
		 * @type {RenderTarget}
		 */
		this._hizRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: FloatType, format: RedFormat, minFilter: NearestFilter, magFilter: NearestFilter } );
		this._hizRenderTarget.texture.name = 'SSSRNode.HiZ';
		this._hizRenderTarget.texture.generateMipmaps = false;
		// `texture.mipmaps.length` is the total mip level count (including base) in three.js
		for ( let i = 0; i < HIZ_MIP_COUNT; i ++ ) this._hizRenderTarget.texture.mipmaps.push( {} );

		/**
		 * Scratch HiZ render target used as the sampled source during downsampling to
		 * avoid a read/write conflict on `_hizRenderTarget` within the same render pass.
		 *
		 * @private
		 * @type {RenderTarget}
		 */
		this._hizScratchRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: FloatType, format: RedFormat, minFilter: NearestFilter, magFilter: NearestFilter } );
		this._hizScratchRenderTarget.texture.name = 'SSSRNode.HiZ.Scratch';
		this._hizScratchRenderTarget.texture.generateMipmaps = false;
		for ( let i = 0; i < HIZ_MIP_COUNT; i ++ ) this._hizScratchRenderTarget.texture.mipmaps.push( {} );

		/**
		 * The render target the SSSR result is rendered into.
		 *
		 * @private
		 * @type {RenderTarget}
		 */
		this._sssrRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );
		this._sssrRenderTarget.texture.name = 'SSSRNode.SSR';

		/**
		 * Material for copying the scene depth into mip 0 of the HiZ pyramid.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._hizCopyMaterial = new NodeMaterial();
		this._hizCopyMaterial.name = 'SSSRNode.HizCopy';

		/**
		 * Material that downsamples one HiZ mip to the next by taking the min of four
		 * neighboring texels.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._hizDownsampleMaterial = new NodeMaterial();
		this._hizDownsampleMaterial.name = 'SSSRNode.HizDownsample';

		/**
		 * Main material that performs the stochastic HiZ ray march.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._sssrMaterial = new NodeMaterial();
		this._sssrMaterial.name = 'SSSRNode.SSR';

		/**
		 * The result of the effect is represented as a separate texture node.
		 *
		 * @private
		 * @type {PassTextureNode}
		 */
		this._textureNode = passTexture( this, this._sssrRenderTarget.texture );

	}

	/**
	 * Returns the result of the effect as a texture node.
	 *
	 * @return {PassTextureNode} A texture node that represents the result of the effect.
	 */
	getTextureNode() {

		return this._textureNode;

	}

	/**
	 * Sets the size of the effect.
	 *
	 * @param {number} width - The width of the effect.
	 * @param {number} height - The height of the effect.
	 */
	setSize( width, height ) {

		width = Math.round( this.resolutionScale * width );
		height = Math.round( this.resolutionScale * height );

		this._resolution.value.set( width, height );
		this._sssrRenderTarget.setSize( width, height );
		this._hizRenderTarget.setSize( width, height );
		this._hizScratchRenderTarget.setSize( width, height );

	}

	/**
	 * This method is used to render the effect once per frame.
	 *
	 * @param {NodeFrame} frame - The current node frame.
	 */
	updateBefore( frame ) {

		const { renderer } = frame;

		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		const size = renderer.getDrawingBufferSize( _size );
		this.setSize( size.width, size.height );

		renderer.setMRT( null );
		renderer.setClearColor( 0x000000, 0 );

		// temporal decorrelation for the stochastic reflection direction

		this._frameIndex.value = ( this._frameIndex.value + 1 ) % 64;

		// 1. build HiZ pyramid
		//    mip 0: copy the scene depth into the scratch target (the scratch acts as
		//    the sampled source for the first downsample).

		_quadMesh.material = this._hizCopyMaterial;
		_quadMesh.name = 'SSSR [ HiZ Mip 0 ]';
		renderer.setRenderTarget( this._hizScratchRenderTarget, 0, 0 );
		_quadMesh.render( renderer );

		// copy mip 0 (full resolution) from the scratch into the final target
		_copyRegion.min.set( 0, 0 );
		_copyRegion.max.set( this._resolution.value.x, this._resolution.value.y );
		renderer.copyTextureToTexture( this._hizScratchRenderTarget.texture, this._hizRenderTarget.texture, _copyRegion, null, 0, 0 );

		// mip 1..N-1: downsample min from the scratch's previous mip into the final
		// target's current mip, then copy the new mip back into the scratch so that
		// the next iteration can read it without a read/write conflict.

		for ( let i = 1; i < HIZ_MIP_COUNT; i ++ ) {

			this._hizSourceMip.value = i - 1;

			_quadMesh.material = this._hizDownsampleMaterial;
			_quadMesh.name = 'SSSR [ HiZ Mip ' + i + ' ]';
			renderer.setRenderTarget( this._hizRenderTarget, 0, i );
			_quadMesh.render( renderer );

			// copy the just-written mip back into the scratch so the next iteration
			// can sample it without a read/write conflict. The copy size must match
			// the mip level's dimensions, not the base texture size.
			const mipWidth = Math.max( 1, this._resolution.value.x >> i );
			const mipHeight = Math.max( 1, this._resolution.value.y >> i );
			_copyRegion.min.set( 0, 0 );
			_copyRegion.max.set( mipWidth, mipHeight );
			renderer.copyTextureToTexture( this._hizRenderTarget.texture, this._hizScratchRenderTarget.texture, _copyRegion, null, i, i );

		}

		// 2. raymarch

		_quadMesh.material = this._sssrMaterial;
		_quadMesh.name = 'SSSR [ Ray March ]';
		renderer.setRenderTarget( this._sssrRenderTarget );
		_quadMesh.render( renderer );

		// restore

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	/**
	 * This method is used to setup the effect's TSL code.
	 *
	 * @param {NodeBuilder} builder - The current node builder.
	 * @return {PassTextureNode}
	 */
	setup( builder ) {

		const uvNode = uv();

		// Sample the scene depth, unflattening a logarithmic depth buffer if necessary.

		const sampleDepth = ( uv ) => {

			const depth = this.depthNode.sample( uv ).r;

			if ( builder.renderer.logarithmicDepthBuffer === true ) {

				const viewZ = logarithmicDepthToViewZ( depth, this._cameraNear, this._cameraFar );

				return viewZToPerspectiveDepth( viewZ, this._cameraNear, this._cameraFar );

			}

			return depth;

		};

		// Converts a NDC depth value to view-space z. Used by ValidateHit().

		const depthToViewZ = Fn( ( [ depth ] ) => {

			if ( this.camera.isPerspectiveCamera ) {

				return perspectiveDepthToViewZ( depth, this._cameraNear, this._cameraFar );

			} else {

				return orthographicDepthToViewZ( depth, this._cameraNear, this._cameraFar );

			}

		} );

		// ------------------------------------------------------------
		// HiZ mip 0 copy material
		// ------------------------------------------------------------
		// Writes the scene depth verbatim into the red channel of mip 0 of the scratch
		// HiZ target. The scratch target is used as the sampled source for the first
		// downsample pass.

		this._hizCopyMaterial.fragmentNode = Fn( () => {

			const d = sampleDepth( uvNode );
			return vec4( d, 0, 0, 1 );

		} )().context( builder.getSharedContext() );
		this._hizCopyMaterial.needsUpdate = true;

		// ------------------------------------------------------------
		// HiZ downsample material
		// ------------------------------------------------------------
		// For each destination texel, fetch the 2x2 source block at the previous mip
		// and output the minimum depth. The source comes from the scratch target.

		this._hizDownsampleMaterial.fragmentNode = Fn( () => {

			const srcTex = texture( this._hizScratchRenderTarget.texture );
			const srcMip = this._hizSourceMip;

			// destination pixel (at the current mip level that we're writing to)
			const dstPixel = ivec2( screenCoordinate.xy ).toConst();
			const srcBase = dstPixel.mul( 2 ).toConst();

			const a = textureLoad( srcTex, srcBase.add( ivec2( 0, 0 ) ), srcMip ).r;
			const b = textureLoad( srcTex, srcBase.add( ivec2( 1, 0 ) ), srcMip ).r;
			const c = textureLoad( srcTex, srcBase.add( ivec2( 0, 1 ) ), srcMip ).r;
			const d = textureLoad( srcTex, srcBase.add( ivec2( 1, 1 ) ), srcMip ).r;

			return vec4( min( min( a, b ), min( c, d ) ), 0, 0, 1 );

		} )().context( builder.getSharedContext() );
		this._hizDownsampleMaterial.needsUpdate = true;

		// ------------------------------------------------------------
		// Main SSSR material
		// ------------------------------------------------------------

		// Samples the HiZ min-depth at the given integer coordinate and mip level.

		const sampleHiZ = Fn( ( [ coord, mipLevel ] ) => {

			return textureLoad( texture( this._hizRenderTarget.texture ), coord, mipLevel ).r;

		} );

		// Returns the size of the given HiZ mip. Matches FidelityFX's GetMipResolution
		// (unrounded; non-power-of-2 resolutions may be off by a sub-pixel at coarser
		// mips but this is acceptable for raymarching).

		const getMipResolution = Fn( ( [ mipLevel ] ) => {

			return this._resolution.mul( exp2( float( mipLevel ).negate() ) );

		} );

		// Heitz 2018 GGX VNDF sampling. `Ve` is the view direction in tangent space
		// (i.e. normal = +Z). `alpha` is the GGX roughness (roughness^2).
		//
		// Reference: "Sampling the GGX Distribution of Visible Normals", Heitz 2018.
		// https://jcgt.org/published/0007/04/01/

		const sampleGGXVNDF = Fn( ( [ Ve, alpha, u ] ) => {

			// Section 3.2: transforming the view direction to the hemisphere configuration
			const Vh = normalize( vec3( Ve.x.mul( alpha ), Ve.y.mul( alpha ), Ve.z ) ).toVar();

			// Section 4.1: orthonormal basis (with special case if cross product is zero)
			const lensq = Vh.x.mul( Vh.x ).add( Vh.y.mul( Vh.y ) );
			const T1 = select(
				lensq.greaterThan( 0 ),
				vec3( Vh.y.negate(), Vh.x, 0 ).mul( inversesqrt( max( lensq, float( 1e-6 ) ) ) ),
				vec3( 1, 0, 0 )
			).toVar();
			const T2 = cross( Vh, T1 ).toVar();

			// Section 4.2: parameterization of the projected area
			const r = sqrt( u.x );
			const phi = float( 2 ).mul( PI ).mul( u.y );
			const t1 = r.mul( cos( phi ) ).toVar();
			const t2Raw = r.mul( sin( phi ) );
			const s = float( 0.5 ).mul( float( 1 ).add( Vh.z ) );
			const t2 = float( 1 ).sub( s ).mul( sqrt( max( float( 0 ), float( 1 ).sub( t1.mul( t1 ) ) ) ) ).add( s.mul( t2Raw ) ).toVar();

			// Section 4.3: reprojection onto hemisphere
			const Nh = T1.mul( t1 ).add( T2.mul( t2 ) ).add( Vh.mul( sqrt( max( float( 0 ), float( 1 ).sub( t1.mul( t1 ) ).sub( t2.mul( t2 ) ) ) ) ) );

			// Section 3.4: transforming the normal back to the ellipsoid configuration
			return normalize( vec3( Nh.x.mul( alpha ), Nh.y.mul( alpha ), max( float( 0 ), Nh.z ) ) );

		} );

		// Computes a stochastic reflection direction in view space for the given
		// surface using GGX VNDF importance sampling.

		const sampleReflectionDirection = Fn( ( [ viewDir, viewNormal, alpha, u ] ) => {

			// Branchless Frisvad 2012 orthonormal basis around the view normal.
			// Handles viewNormal.z close to -1 by flipping the sign.
			const n = viewNormal;
			const signZ = select( n.z.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) ).toVar();
			const a = float( - 1 ).div( signZ.add( n.z ) ).toVar();
			const b = n.x.mul( n.y ).mul( a ).toVar();
			const T = vec3( float( 1 ).add( signZ.mul( n.x.mul( n.x ) ).mul( a ) ), signZ.mul( b ), signZ.negate().mul( n.x ) ).toVar();
			const B = vec3( b, signZ.add( n.y.mul( n.y ).mul( a ) ), n.y.negate() ).toVar();
			const N = n;

			// V in tangent space: V dotted with each basis vector
			const vTan = vec3( dot( viewDir, T ), dot( viewDir, B ), dot( viewDir, N ) );

			// Sampled half-vector in tangent space
			const hTan = sampleGGXVNDF( vTan, alpha, u );

			// Reflect V around H, both in tangent space
			const rTan = reflect( vTan.negate(), hTan );

			// Back to view space: R = T * rTan.x + B * rTan.y + N * rTan.z
			return normalize( T.mul( rTan.x ).add( B.mul( rTan.y ) ).add( N.mul( rTan.z ) ) );

		} );

		// Projects a view-space point to screen space. Returns xy in [0,1] UV and z in
		// NDC depth (WebGPU/Three.js convention: [0,1], 0 is near).

		const projectViewToScreen = Fn( ( [ viewPosition ] ) => {

			const clip = this._cameraProjectionMatrix.mul( vec4( viewPosition, 1 ) );
			const ndc = clip.xyz.div( clip.w );
			// NDC xy is in [-1,1]; convert to UV [0,1]. Flip Y to match the UV convention
			// used by getViewPosition() (which mirrors Y to match WebGPU clip space).
			const uvXY = vec2( ndc.x.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( ndc.y.mul( 0.5 ) ) );
			// NDC z in WebGPU is already in [0,1]
			return vec3( uvXY, ndc.z );

		} );

		// FidelityFX-style hierarchical ray march in screen-UV + NDC depth space.
		//
		// Input:
		//   origin    : vec3 — starting point (uv.x, uv.y, ndc.z)
		//   direction : vec3 — ray delta in the same space (not normalized)
		//
		// Output:
		//   vec4(hit_uv.x, hit_uv.y, hit_ndc_z, valid)
		//
		// Uses a min-depth HiZ: descends the mip chain when a z-intersection is
		// possible and ascends when a tile can be skipped. Because the HiZ stores the
		// minimum depth of its children, any ray whose z is smaller than the tile's
		// min-depth cannot intersect geometry inside that tile and is safe to skip.

		const hierarchicalRaymarch = Fn( ( [ origin, direction ] ) => {

			const screenSize = this._resolution.toVar();

			// safe inverse direction — replace zeros with a large number so division is well-defined
			const invDir = vec3(
				select( abs( direction.x ).greaterThan( 1e-6 ), float( 1 ).div( direction.x ), float( 1e6 ) ),
				select( abs( direction.y ).greaterThan( 1e-6 ), float( 1 ).div( direction.y ), float( 1e6 ) ),
				select( abs( direction.z ).greaterThan( 1e-6 ), float( 1 ).div( direction.z ), float( 1e6 ) )
			).toVar();

			const mostDetailedMip = this.mostDetailedMip;
			const currentMip = int( mostDetailedMip ).toVar();
			const currentMipRes = getMipResolution( currentMip ).toVar();
			const currentMipResInv = float( 1 ).div( currentMipRes ).toVar();

			// Bias that prevents the ray from getting stuck on the edge of its starting
			// texel. See `InitialAdvanceRay` in FidelityFX-SSSR.
			const uvOffsetBase = float( 0.005 ).mul( exp2( float( mostDetailedMip ) ) ).div( screenSize );
			const uvOffset = vec2(
				select( direction.x.lessThan( 0 ), uvOffsetBase.x.negate(), uvOffsetBase.x ),
				select( direction.y.lessThan( 0 ), uvOffsetBase.y.negate(), uvOffsetBase.y )
			).toVar();

			// For each axis, pick the far edge of the current cell (the one the ray
			// advances towards).
			const floorOffset = vec2(
				select( direction.x.lessThan( 0 ), float( 0 ), float( 1 ) ),
				select( direction.y.lessThan( 0 ), float( 0 ), float( 1 ) )
			).toVar();

			// Initial advance: push the ray to the far edge of the starting texel so
			// it enters a new cell on the very first loop iteration.
			const position = origin.toVar();
			{

				const currentMipPos = currentMipRes.mul( origin.xy );
				const xyPlane = floor( currentMipPos ).add( floorOffset ).mul( currentMipResInv ).add( uvOffset );
				const tInit = xyPlane.mul( invDir.xy ).sub( origin.xy.mul( invDir.xy ) );
				const tStart = min( tInit.x, tInit.y );
				position.assign( origin.add( direction.mul( tStart ) ) );

			}

			const validHit = float( 0 ).toVar();

			Loop( { start: int( 0 ), end: int( this.maxIterations ), type: 'int', condition: '<' }, () => {

				// Terminate if we've descended below the finest allowed mip — that
				// means we found a valid intersection in the previous iteration.
				If( currentMip.lessThan( int( mostDetailedMip ) ), () => {

					validHit.assign( 1 );
					Break();

				} );

				// Terminate if we've left the screen.
				If( position.x.lessThan( 0 ).or( position.x.greaterThan( 1 ) ).or( position.y.lessThan( 0 ) ).or( position.y.greaterThan( 1 ) ), () => {

					Break();

				} );

				const currentMipPos = currentMipRes.mul( position.xy );
				const hizCoord = ivec2( currentMipPos );
				const surfaceZ = sampleHiZ( hizCoord, currentMip ).toVar();

				// Plane intersection for x, y (tile boundaries) and z (HiZ surface)
				const xyPlane = floor( currentMipPos ).add( floorOffset ).mul( currentMipResInv ).add( uvOffset );
				const tXY = xyPlane.mul( invDir.xy ).sub( origin.xy.mul( invDir.xy ) );
				const tZRaw = surfaceZ.mul( invDir.z ).sub( origin.z.mul( invDir.z ) );

				// For non-inverted depth (z=0 near, z=1 far), only trust the z-plane
				// intersection when the ray is actually heading towards the far plane
				// (direction.z > 0). Otherwise force it to be larger than any xy plane.
				const tZ = select( direction.z.greaterThan( 0 ), tZRaw, float( 1e6 ) ).toVar();
				const tXYMin = min( tXY.x, tXY.y ).toVar();
				const tMin = min( tXYMin, tZ ).toVar();

				// The ray is still above the HiZ surface if the tile's min depth is
				// greater than the ray's current z — meaning there's no geometry
				// between the ray and that depth.
				const aboveSurface = surfaceZ.greaterThan( position.z ).toVar();

				// If the closest plane was an xy boundary (strictly closer than tZ)
				// AND we're still above the surface, we can skip this tile and ascend
				// to a coarser mip. Otherwise we've entered a potential hit cell and
				// should descend.
				const skippedTile = tXYMin.lessThan( tZ ).and( aboveSurface ).toVar();

				If( aboveSurface, () => {

					position.assign( origin.add( direction.mul( tMin ) ) );

				} );

				// Adjust mip level
				If( skippedTile, () => {

					currentMip.addAssign( 1 );
					currentMipRes.assign( currentMipRes.mul( 0.5 ) );
					currentMipResInv.assign( currentMipResInv.mul( 2 ) );

				} ).Else( () => {

					currentMip.subAssign( 1 );
					currentMipRes.assign( currentMipRes.mul( 2 ) );
					currentMipResInv.assign( currentMipResInv.mul( 0.5 ) );

				} );

			} );

			return vec4( position.x, position.y, position.z, validHit );

		} );

		// Rejects hits that are off-screen, back-facing, on the sky, or too far from
		// their supposed intersection surface. Returns a [0,1] confidence that can be
		// used as an opacity modulator.

		const validateHit = Fn( ( [ hit, hitViewZ, rayViewDir ] ) => {

			const confidence = float( 1 ).toVar();

			// outside [0,1]
			If( hit.x.lessThan( 0 ).or( hit.x.greaterThan( 1 ) ).or( hit.y.lessThan( 0 ) ).or( hit.y.greaterThan( 1 ) ), () => {

				confidence.assign( 0 );

			} );

			// skybox / max-depth
			If( hit.z.greaterThanEqual( 1 ), () => {

				confidence.assign( 0 );

			} );

			// thickness rejection: compare the hit's view-space z to the ray's view-space
			// z at the same position. If they differ by more than `thickness`, fade out.
			const hitSurfaceViewZ = depthToViewZ( sampleDepth( hit.xy ) );
			const delta = abs( hitSurfaceViewZ.sub( hitViewZ ) );
			const thicknessFade = float( 1 ).sub( delta.div( this.thickness ).clamp() );
			confidence.mulAssign( thicknessFade.mul( thicknessFade ) );

			// screen-edge fade
			const d = min( hit.xy, float( 1 ).sub( hit.xy ) );
			const edge = min( d.x, d.y ).div( 0.05 ).clamp();
			confidence.mulAssign( edge );

			// back-face rejection: sample the surface normal at the hit and reject if
			// it faces away from the reflected ray.
			const hitNormal = this.normalNode.sample( hit.xy ).rgb.normalize();
			If( dot( hitNormal, rayViewDir ).greaterThan( 0 ), () => {

				confidence.assign( 0 );

			} );

			return confidence;

		} );

		// Two low-discrepancy pseudo-random values in [0,1) derived from the pixel
		// coordinate and the frame index. Interleaved gradient noise is already used
		// elsewhere in the repo (SSGI, shadow filter) — it's a drop-in stand-in for the
		// precomputed blue noise that FidelityFX SSSR ships with.

		const getRandomSample = Fn( ( [ pixel ] ) => {

			const u1 = interleavedGradientNoise( pixel.add( vec2( this._frameIndex.mul( 5.588238 ), this._frameIndex.mul( 3.214141 ) ) ) );
			const u2 = interleavedGradientNoise( pixel.add( vec2( this._frameIndex.mul( 2.971321 ), this._frameIndex.mul( 7.128342 ) ) ).add( vec2( 37.31, 19.97 ) ) );
			return vec2( u1, u2 );

		} );

		// ------------------------------------------------------------
		// Main SSSR pass
		// ------------------------------------------------------------

		const sssr = Fn( () => {

			const output = vec4( 0 ).toVar();

			const metalness = float( this.metalnessNode ).toVar();
			const perceptualRoughness = float( this.roughnessNode ).toVar();

			// Non-metals don't contribute screen space reflections in this simplified port.
			metalness.equal( 0 ).discard();

			const depth = sampleDepth( uvNode ).toVar();
			depth.greaterThanEqual( 1 ).discard();

			// View-space quantities.
			const viewPosition = getViewPosition( uvNode, depth, this._cameraProjectionMatrixInverse ).toVar();
			const viewNormal = this.normalNode.sample( uvNode ).rgb.normalize().toVar();
			// view direction points from surface to camera
			const viewDir = normalize( viewPosition.negate() ).toVar();

			// GGX alpha from perceptual roughness (same convention as three.js PBR).
			const alpha = perceptualRoughness.mul( perceptualRoughness ).toVar();

			// Stochastic reflection direction in view space.
			const u = getRandomSample( screenCoordinate.xy );
			const reflectDirView = sampleReflectionDirection( viewDir, viewNormal, alpha, u ).toVar();

			// Reject rays that would march under the surface (sampled microfacet
			// normal pointed the wrong way for this view).
			If( dot( reflectDirView, viewNormal ).greaterThan( 0 ), () => {

				// Convert the (origin, direction) pair to screen space.
				const screenOrigin = vec3( uvNode, depth ).toVar();
				const endView = viewPosition.add( reflectDirView );
				const screenEnd = projectViewToScreen( endView );
				const screenDir = screenEnd.sub( screenOrigin ).toVar();

				// Raymarch.
				const hitResult = hierarchicalRaymarch( screenOrigin, screenDir ).toVar();
				const validHit = hitResult.w;

				If( validHit.greaterThan( 0.5 ), () => {

					const hitUV = hitResult.xy.toVar();
					const hitDepth = hitResult.z.toVar();

					// Reconstruct the hit position in view space for thickness checks and
					// distance attenuation.
					const hitViewPosition = getViewPosition( hitUV, hitDepth, this._cameraProjectionMatrixInverse ).toVar();

					const confidence = validateHit( vec3( hitUV, hitDepth ), hitViewPosition.z, reflectDirView ).toVar();

					If( confidence.greaterThan( 0 ), () => {

						// Schlick fresnel with a fixed F0 = 0.04 (dielectric base). Metals
						// get further boosted by the metalness multiplier below.
						const NdotV = max( dot( viewNormal, viewDir ), float( 0 ) );
						const fresnel = float( 1 ).sub( NdotV ).pow( 5 ).mul( 0.96 ).add( 0.04 );

						// View-space distance from the surface to the actual hit point.
						const rayLength = hitViewPosition.sub( viewPosition ).length();
						const distanceAtten = float( 1 ).sub( rayLength.div( this.maxDistance ).clamp() );

						const op = this.opacity.mul( metalness ).mul( fresnel ).mul( confidence ).mul( distanceAtten );

						const reflectColor = this.colorNode.sample( hitUV );
						output.assign( vec4( reflectColor.rgb.mul( op ), op ) );

					} );

				} );

			} );

			return output;

		} );

		this._sssrMaterial.fragmentNode = sssr().context( builder.getSharedContext() );
		this._sssrMaterial.needsUpdate = true;

		return this._textureNode;

	}

	/**
	 * Frees internal resources. This method should be called
	 * when the effect is no longer required.
	 */
	dispose() {

		this._hizRenderTarget.dispose();
		this._hizScratchRenderTarget.dispose();
		this._sssrRenderTarget.dispose();

		this._hizCopyMaterial.dispose();
		this._hizDownsampleMaterial.dispose();
		this._sssrMaterial.dispose();

	}

}

export default SSSRNode;

/**
 * TSL function for creating Stochastic Screen Space Reflections (SSSR), a simplified
 * port of AMD FidelityFX SSSR.
 *
 * @tsl
 * @function
 * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
 * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
 * @param {Node<vec3>} normalNode - A node that represents the beauty pass's view-space normals.
 * @param {Node<float>} metalnessNode - A node that represents the beauty pass's metalness.
 * @param {Node<float>} roughnessNode - A node that represents the beauty pass's roughness (perceptual).
 * @param {?Camera} [camera=null] - The camera the scene is rendered with.
 * @returns {SSSRNode}
 */
export const sssr = ( colorNode, depthNode, normalNode, metalnessNode, roughnessNode, camera = null ) => new SSSRNode( nodeObject( colorNode ), nodeObject( depthNode ), nodeObject( normalNode ), nodeObject( metalnessNode ), nodeObject( roughnessNode ), camera );
