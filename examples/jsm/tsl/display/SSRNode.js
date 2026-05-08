import { HalfFloatType, RenderTarget, Vector2, RendererUtils, QuadMesh, TempNode, NodeMaterial, NodeUpdateType } from 'three/webgpu';
import { reference, viewZToPerspectiveDepth, logarithmicDepthToViewZ, getScreenPosition, getViewPosition, mul, div, cross, float, Continue, Break, Loop, int, max, min, abs, sub, If, dot, reflect, normalize, select, sin, cos, sqrt, inversesqrt, fract, PI, interleavedGradientNoise, screenCoordinate, nodeObject, Fn, passTexture, uv, uniform, perspectiveDepthToViewZ, orthographicDepthToViewZ, vec2, vec3, vec4 } from 'three/tsl';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();
let _rendererState;

/**
 * Post processing node for computing screen space reflections (SSR).
 *
 * When `roughnessNode` is provided, the per-pixel reflection direction is drawn
 * from the GGX distribution of visible normals (Heitz 2018) using the surface
 * roughness as the cone width. This produces physically-based glossy reflections
 * directly from one stochastic sample per pixel — no separate blur pass is
 * needed. Pair with a temporal anti-aliasing node (e.g. `TRAANode`) to
 * accumulate the per-frame stochastic samples into a smooth result.
 *
 * If `roughnessNode` is `null`, a perfect mirror reflection is used (the legacy
 * SSR behavior).
 *
 * Reference: {@link https://lettier.github.io/3d-game-shaders-for-beginners/screen-space-reflection.html}
 *
 * @augments TempNode
 * @three_import import { ssr } from 'three/addons/tsl/display/SSRNode.js';
 */
class SSRNode extends TempNode {

	static get type() {

		return 'SSRNode';

	}

	/**
	 * Constructs a new SSR node.
	 *
	 * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
	 * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
	 * @param {Node<vec3>} normalNode - A node that represents the beauty pass's normals.
	 * @param {Node<float>} metalnessNode - A node that represents the beauty pass's metalness.
	 * @param {?Node<float>} [roughnessNode=null] - A node that represents the beauty pass's roughness. When provided, drives the GGX VNDF cone width for stochastic glossy reflections; when `null`, mirror reflections are used.
	 * @param {?Camera} [camera=null] - The camera the scene is rendered with.
	 */
	constructor( colorNode, depthNode, normalNode, metalnessNode, roughnessNode = null, camera = null ) {

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
		 * A node that represents the beauty pass's normals.
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
		 * A node that represents the beauty pass's roughness. Drives the cone width
		 * of the GGX VNDF stochastic reflection direction. When `null`, a perfect
		 * mirror reflection is used.
		 *
		 * @type {?Node<float>}
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
		 * Controls how far a fragment can reflect. Increasing this value result in more
		 * computational overhead but also increases the reflection distance.
		 *
		 * @type {UniformNode<float>}
		 */
		this.maxDistance = uniform( 1 );

		/**
		 * Controls the cutoff between what counts as a possible reflection hit and what does not.
		 *
		 * @type {UniformNode<float>}
		 */
		this.thickness = uniform( 0.1 );

		/**
		 * Controls how the SSR reflections are blended with the beauty pass.
		 *
		 * @type {UniformNode<float>}
		 */
		this.opacity = uniform( 1 );

		/**
		 * This parameter controls how detailed the raymarching process works.
		 * The value ranges is `[0,1]` where `1` means best quality (the maximum number
		 * of raymarching iterations/samples) and `0` means no samples at all.
		 *
		 * A quality of `0.5` is usually sufficient for most use cases. Try to keep
		 * this parameter as low as possible. Larger values result in noticeable more
		 * overhead.
		 *
		 * @type {UniformNode<float>}
		 */
		this.quality = uniform( 0.5 );

		//

		if ( camera === null ) {

			if ( this.colorNode.passNode && this.colorNode.passNode.isPassNode === true ) {

				camera = this.colorNode.passNode.camera;

			} else {

				throw new Error( 'THREE.TSL: No camera found. ssr() requires a camera.' );

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
		 * Whether the scene's camera is perspective or orthographic.
		 *
		 * @private
		 * @type {UniformNode<bool>}
		 */
		this._isPerspectiveCamera = uniform( camera.isPerspectiveCamera === true );

		/**
		 * The resolution of the pass.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._resolution = uniform( new Vector2() );

		/**
		 * Frame counter used as a temporal decorrelation seed for the stochastic
		 * reflection direction. Only used when `roughnessNode` is provided.
		 *
		 * @private
		 * @type {UniformNode<float>}
		 */
		this._frameIndex = uniform( 0 );

		/**
		 * The render target the SSR is rendered into.
		 *
		 * @private
		 * @type {RenderTarget}
		 */
		this._ssrRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );
		this._ssrRenderTarget.texture.name = 'SSRNode.SSR';

		/**
		 * The material that is used to render the effect.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._ssrMaterial = new NodeMaterial();
		this._ssrMaterial.name = 'SSRNode.SSR';

		/**
		 * The result of the effect is represented as a separate texture node.
		 *
		 * @private
		 * @type {PassTextureNode}
		 */
		this._textureNode = passTexture( this, this._ssrRenderTarget.texture );

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
		this._ssrRenderTarget.setSize( width, height );

	}

	/**
	 * This method is used to render the effect once per frame.
	 *
	 * @param {NodeFrame} frame - The current node frame.
	 */
	updateBefore( frame ) {

		const { renderer } = frame;

		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		const ssrRenderTarget = this._ssrRenderTarget;

		const size = renderer.getDrawingBufferSize( _size );

		_quadMesh.material = this._ssrMaterial;

		this.setSize( size.width, size.height );

		// clear

		renderer.setMRT( null );
		renderer.setClearColor( 0x000000, 0 );

		// temporal decorrelation seed for stochastic sampling

		this._frameIndex.value = ( this._frameIndex.value + 1 ) % 64;

		// ssr

		renderer.setRenderTarget( ssrRenderTarget );
		_quadMesh.name = 'SSR [ Reflections ]';
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

		const pointToLineDistance = Fn( ( [ point, linePointA, linePointB ] )=> {

			// https://mathworld.wolfram.com/Point-LineDistance3-Dimensional.html

			return cross( point.sub( linePointA ), point.sub( linePointB ) ).length().div( linePointB.sub( linePointA ).length() );

		} );

		const pointPlaneDistance = Fn( ( [ point, planePoint, planeNormal ] )=> {

			// https://mathworld.wolfram.com/Point-PlaneDistance.html
			// https://en.wikipedia.org/wiki/Plane_(geometry)
			// http://paulbourke.net/geometry/pointlineplane/

			// planeNormal is already normalized, so denominator is 1
			const d = mul( planeNormal.x, planePoint.x ).add( mul( planeNormal.y, planePoint.y ) ).add( mul( planeNormal.z, planePoint.z ) ).negate().toVar();
			const distance = mul( planeNormal.x, point.x ).add( mul( planeNormal.y, point.y ) ).add( mul( planeNormal.z, point.z ) ).add( d );
			return distance;

		} );

		const getViewZ = Fn( ( [ depth ] ) => {

			let viewZNode;

			if ( this.camera.isPerspectiveCamera ) {

				viewZNode = perspectiveDepthToViewZ( depth, this._cameraNear, this._cameraFar );

			} else {

				viewZNode = orthographicDepthToViewZ( depth, this._cameraNear, this._cameraFar );

			}

			return viewZNode;

		} );

		const sampleDepth = ( uv ) => {

			const depth = this.depthNode.sample( uv ).r;

			if ( builder.renderer.logarithmicDepthBuffer === true ) {

				const viewZ = logarithmicDepthToViewZ( depth, this._cameraNear, this._cameraFar );

				return viewZToPerspectiveDepth( viewZ, this._cameraNear, this._cameraFar );

			}

			return depth;

		};

		// Heitz 2018 GGX VNDF sampling. `Ve` is the view direction in tangent
		// space (normal = +Z). `alpha` is the GGX roughness (perceptual^2).
		//
		// Reference: "Sampling the GGX Distribution of Visible Normals", Heitz 2018.
		// https://jcgt.org/published/0007/04/01/

		const sampleGGXVNDF = Fn( ( [ Ve, alpha, u ] ) => {

			// Section 3.2: transform the view direction to the hemisphere configuration
			const Vh = normalize( vec3( Ve.x.mul( alpha ), Ve.y.mul( alpha ), Ve.z ) ).toVar();

			// Section 4.1: orthonormal basis (degenerate case if cross product is zero)
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

			// Section 4.3: reproject onto hemisphere
			const Nh = T1.mul( t1 ).add( T2.mul( t2 ) ).add( Vh.mul( sqrt( max( float( 0 ), float( 1 ).sub( t1.mul( t1 ) ).sub( t2.mul( t2 ) ) ) ) ) );

			// Section 3.4: transform the normal back to the ellipsoid configuration
			return normalize( vec3( Nh.x.mul( alpha ), Nh.y.mul( alpha ), max( float( 0 ), Nh.z ) ) );

		} );

		// Stochastic reflection direction in view space: builds a TBN frame
		// around the view normal, transforms the view direction into it, samples
		// a half-vector via GGX VNDF, reflects, and transforms back.

		const sampleReflectionDirection = Fn( ( [ viewDir, viewNormal, alpha, u ] ) => {

			// Branchless Frisvad 2012 orthonormal basis around the view normal.
			const n = viewNormal;
			const signZ = select( n.z.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) ).toVar();
			const a = float( - 1 ).div( signZ.add( n.z ) ).toVar();
			const b = n.x.mul( n.y ).mul( a ).toVar();
			const T = vec3( float( 1 ).add( signZ.mul( n.x.mul( n.x ) ).mul( a ) ), signZ.mul( b ), signZ.negate().mul( n.x ) ).toVar();
			const B = vec3( b, signZ.add( n.y.mul( n.y ).mul( a ) ), n.y.negate() ).toVar();
			const N = n;

			const vTan = vec3( dot( viewDir, T ), dot( viewDir, B ), dot( viewDir, N ) );
			const hTan = sampleGGXVNDF( vTan, alpha, u );
			const rTan = reflect( vTan.negate(), hTan );

			return normalize( T.mul( rTan.x ).add( B.mul( rTan.y ) ).add( N.mul( rTan.z ) ) );

		} );

		const getRandomSample = Fn( ( [ pixel ] ) => {

			const u1 = interleavedGradientNoise( pixel.add( vec2( this._frameIndex.mul( 5.588238 ), this._frameIndex.mul( 3.214141 ) ) ) );
			const u2 = interleavedGradientNoise( pixel.add( vec2( this._frameIndex.mul( 2.971321 ), this._frameIndex.mul( 7.128342 ) ) ).add( vec2( 37.31, 19.97 ) ) );
			return vec2( u1, u2 );

		} );

		const ssr = Fn( () => {

			const metalness = float( this.metalnessNode );

			// fragments with no metalness do not reflect their environment
			metalness.equal( 0.0 ).discard();

			// compute some standard FX entities
			const depth = sampleDepth( uvNode ).toVar();
			const viewPosition = getViewPosition( uvNode, depth, this._cameraProjectionMatrixInverse ).toVar();
			const viewNormal = this.normalNode.rgb.normalize().toVar();

			// compute the direction from the position in view space to the camera
			const viewIncidentDir = ( ( this.camera.isPerspectiveCamera ) ? normalize( viewPosition ) : vec3( 0, 0, - 1 ) ).toVar();

			// Reflection direction. When a roughness node is supplied, sample a single
			// stochastic direction from the GGX distribution of visible normals — this
			// produces physically-based glossy reflections (one sample per pixel, per
			// frame). Without roughness we fall back to the pure mirror reflection.
			let viewReflectDir;

			if ( this.roughnessNode !== null ) {

				const perceptualRoughness = float( this.roughnessNode );
				const alpha = perceptualRoughness.mul( perceptualRoughness );
				const u = getRandomSample( screenCoordinate.xy );
				viewReflectDir = sampleReflectionDirection( viewIncidentDir.negate(), viewNormal, alpha, u ).toVar();

			} else {

				viewReflectDir = reflect( viewIncidentDir, viewNormal ).toVar();

			}

			// adapt maximum distance to the local geometry (see https://www.mathsisfun.com/algebra/vectors-dot-product.html)
			const maxReflectRayLen = this.maxDistance.div( dot( viewIncidentDir.negate(), viewNormal ) ).toVar();

			// compute the maximum point of the reflection ray in view space
			const d1viewPosition = viewPosition.add( viewReflectDir.mul( maxReflectRayLen ) ).toVar();

			// check if d1viewPosition lies behind the camera near plane
			If( this._isPerspectiveCamera.and( d1viewPosition.z.greaterThan( this._cameraNear.negate() ) ), () => {

				// if so, ensure d1viewPosition is clamped on the near plane.
				// this prevents artifacts during the ray marching process
				const t = sub( this._cameraNear.negate(), viewPosition.z ).div( viewReflectDir.z );
				d1viewPosition.assign( viewPosition.add( viewReflectDir.mul( t ) ) );

			} );

			// d0 and d1 are the start and maximum points of the reflection ray in screen space
			const d0 = screenCoordinate.xy.toVar();
			const d1 = getScreenPosition( d1viewPosition, this._cameraProjectionMatrix ).mul( this._resolution ).toVar();

			// below variables are used to control the raymarching process

			// total length of the ray
			const totalLen = d1.sub( d0 ).length().toVar();

			// offset in x and y direction
			const xLen = d1.x.sub( d0.x ).toVar();
			const yLen = d1.y.sub( d0.y ).toVar();

			// determine the larger delta
			// The larger difference will help to determine how much to travel in the X and Y direction each iteration and
			// how many iterations are needed to travel the entire ray
			const totalStep = int( max( abs( xLen ), abs( yLen ) ).mul( this.quality.clamp() ) ).toConst();

			// step sizes in the x and y directions
			const xSpan = xLen.div( totalStep ).toVar();
			const ySpan = yLen.div( totalStep ).toVar();

			const output = vec4( 0 ).toVar();

			// the actual ray marching loop
			// starting from d0, the code gradually travels along the ray and looks for an intersection with the geometry.
			// it does not exceed d1 (the maximum ray extend)
			Loop( totalStep, ( { i } ) => {

				// advance on the ray by computing a new position in screen coordinates
				const xy = vec2( d0.x.add( xSpan.mul( float( i ) ) ), d0.y.add( ySpan.mul( float( i ) ) ) ).toVar();

				// stop processing if the new position lies outside of the screen
				If( xy.x.lessThan( 0 ).or( xy.x.greaterThan( this._resolution.x ) ).or( xy.y.lessThan( 0 ) ).or( xy.y.greaterThan( this._resolution.y ) ), () => {

					Break();

				} );

				// compute new uv, depth and viewZ for the next fragment
				const uvNode = xy.div( this._resolution );
				const d = sampleDepth( uvNode ).toVar();
				const vZ = getViewZ( d ).toVar();

				const viewReflectRayZ = float( 0 ).toVar();

				// normalized distance between the current position xy and the starting point d0
				const s = xy.sub( d0 ).length().div( totalLen );

				// depending on the camera type, we now compute the z-coordinate of the reflected ray at the current step in view space
				If( this._isPerspectiveCamera, () => {

					const recipVPZ = float( 1 ).div( viewPosition.z ).toVar();
					viewReflectRayZ.assign( float( 1 ).div( recipVPZ.add( s.mul( float( 1 ).div( d1viewPosition.z ).sub( recipVPZ ) ) ) ) );

				} ).Else( () => {

					viewReflectRayZ.assign( viewPosition.z.add( s.mul( d1viewPosition.z.sub( viewPosition.z ) ) ) );

				} );

				// if viewReflectRayZ is less or equal than the real z-coordinate at this place, it potentially intersects the geometry
				If( viewReflectRayZ.lessThanEqual( vZ ), () => {

					// compute the distance of the new location to the ray in view space
					// to clarify vP is the fragment's view position which is not an exact point on the ray
					const vP = getViewPosition( uvNode, d, this._cameraProjectionMatrixInverse ).toVar();
					const away = pointToLineDistance( vP, viewPosition, d1viewPosition ).toVar();

					// compute the minimum thickness between the current fragment and its neighbor in the x-direction.
					const xyNeighbor = vec2( xy.x.add( 1 ), xy.y ).toVar(); // move one pixel
					const uvNeighbor = xyNeighbor.div( this._resolution );
					const vPNeighbor = getViewPosition( uvNeighbor, d, this._cameraProjectionMatrixInverse ).toVar();
					const minThickness = vPNeighbor.x.sub( vP.x ).toVar();
					minThickness.mulAssign( 3 ); // expand a bit to avoid errors

					const tk = max( minThickness, this.thickness ).toVar();

					const thicknessFalloff = float( 1 ).sub( away.div( tk ).clamp() );
					const thicknessConfidence = thicknessFalloff.mul( thicknessFalloff );

					If( thicknessConfidence.greaterThan( 0 ), () => { // potential hit

						const vN = this.normalNode.sample( uvNode ).rgb.normalize().toVar();

						If( dot( viewReflectDir, vN ).greaterThanEqual( 0 ), () => {

							// the reflected ray is pointing towards the same side as the fragment's normal (current ray position),
							// which means it wouldn't reflect off the surface. The loop continues to the next step for the next ray sample.
							Continue();

						} );

						// this distance represents the depth of the intersection point between the reflected ray and the scene.
						const distance = pointPlaneDistance( vP, viewPosition, viewNormal ).toVar();

						If( distance.greaterThan( this.maxDistance ), () => {

							// Distance exceeding limit: The reflection is potentially too far away and
							// might not contribute significantly to the final color
							Break();

						} );

						// distance attenuation (the reflection should fade out the farther it is away from the surface)
						const ratio = float( 1 ).sub( distance.div( this.maxDistance ) ).toVar();
						const distanceConfidence = ratio.mul( ratio );

						// Soft fade as the hit approaches the screen edge (5% border).
						// Stops reflections from popping at the silhouette of the screen.
						const edgeMargin = min( uvNode, vec2( 1 ).sub( uvNode ) );
						const edgeConfidence = min( edgeMargin.x, edgeMargin.y ).div( 0.05 ).clamp();

						const op = this.opacity.mul( metalness ).toVar();
						op.mulAssign( thicknessConfidence );
						op.mulAssign( distanceConfidence );
						op.mulAssign( edgeConfidence );

						// fresnel (reflect more light on surfaces that are viewed at grazing angles)
						const fresnelCoe = div( dot( viewIncidentDir, viewReflectDir ).add( 1 ), 2 );
						op.mulAssign( fresnelCoe );

						// output (premultiplied alpha)
						const reflectColor = this.colorNode.sample( uvNode );
						output.assign( vec4( reflectColor.rgb.mul( op ), op ) );
						Break();

					} );

				} );

			} );

			return output;

		} );

		this._ssrMaterial.fragmentNode = ssr().context( builder.getSharedContext() );
		this._ssrMaterial.needsUpdate = true;

		return this.getTextureNode();

	}

	/**
	 * Frees internal resources. This method should be called
	 * when the effect is no longer required.
	 */
	dispose() {

		this._ssrRenderTarget.dispose();
		this._ssrMaterial.dispose();

	}

}

export default SSRNode;

/**
 * TSL function for creating screen space reflections (SSR).
 *
 * @tsl
 * @function
 * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
 * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
 * @param {Node<vec3>} normalNode - A node that represents the beauty pass's normals.
 * @param {Node<float>} metalnessNode - A node that represents the beauty pass's metalness.
 * @param {?Node<float>} [roughnessNode=null] - A node that represents the beauty pass's roughness.
 * @param {?Camera} [camera=null] - The camera the scene is rendered with.
 * @returns {SSRNode}
 */
export const ssr = ( colorNode, depthNode, normalNode, metalnessNode, roughnessNode = null, camera = null ) => new SSRNode( nodeObject( colorNode ), nodeObject( depthNode ), nodeObject( normalNode ), nodeObject( metalnessNode ), nodeObject( roughnessNode ), camera );
