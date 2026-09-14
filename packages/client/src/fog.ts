import * as THREE from 'three';

/**
 * Туман, стелющийся у земли.
 *
 * Обычный туман three зависит только от дальности: вдалеке всё тонет одинаково,
 * от травы до верхушек башен. Настоящая дымка лежит внизу — дальние стены
 * уходят в неё основанием, а крыши и кроны ещё видны. От этого появляется
 * глубина: даль растворяется, но не пропадает целиком.
 *
 * Как устроено. Подменяются кусочки шейдера тумана — одни на все материалы
 * сцены, поэтому ничего не надо заводить у каждого. В вершинном шейдере
 * к дальности добавляется **высота точки в мире**, во фрагментном к обычному
 * туману — второй слой: тем гуще, чем ниже точка и чем она дальше.
 *
 * Своих параметров шейдеру не нужно: слой берёт дальность у того же тумана.
 * В городе он начинается раньше обычного и густеет к его дальней границе,
 * в подземелье (где туман на пять метров) — ровно так же, только в пять метров.
 * Цвет тот же, что у тумана, — а он и так идёт за небом (daynight.ts).
 *
 * Модуль должен подключиться **до первой отрисовки**: шейдеры собираются один
 * раз, и подмена после этого до уже собранных не дойдёт.
 */

/** Высота, до которой слой густой, м. Выше он сходит на нет. */
const GROUND_FOG_HEIGHT = 2.2;
/** Уровень земли. Мир у нас ровный: и город, и залы подземелья стоят на нуле. */
const GROUND_LEVEL = 0;
/** С какой доли ближней границы тумана слой начинает появляться. */
const GROUND_FOG_START = 0.35;
/** На какой доле дальней границы слой набирает полную силу. */
const GROUND_FOG_FULL = 0.65;
/** Сила слоя: даже у самой земли он не глушит картинку целиком. */
const GROUND_FOG_STRENGTH = 0.7;

const glsl = (value: number): string => value.toFixed(4);

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying float vFogHeight;
#endif
`;

/**
 * Высота в мире — без обратной матрицы: у матрицы вида поворот ортогональный,
 * и обратный к нему — транспонированный. `v * mat3(M)` в GLSL и есть
 * умножение на транспонированную матрицу.
 */
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogHeight = ( ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix ) ).y;
#endif
`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying float vFogHeight;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		float fogLow = clamp( 1.0 - ( vFogHeight - ${glsl(GROUND_LEVEL)} ) / ${glsl(GROUND_FOG_HEIGHT)}, 0.0, 1.0 );
		float fogGround = fogLow * fogLow
			* smoothstep( fogNear * ${glsl(GROUND_FOG_START)}, fogFar * ${glsl(GROUND_FOG_FULL)}, vFogDepth )
			* ${glsl(GROUND_FOG_STRENGTH)};
		fogFactor = max( fogFactor, fogGround );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;
