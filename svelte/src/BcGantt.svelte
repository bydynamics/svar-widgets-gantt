<script>
	import Gantt from "./components/Gantt.svelte";
	import ContextMenu from "./components/ContextMenu.svelte";
	import Editor from "./components/Editor.svelte";
	import Willow from "./themes/Willow.svelte";

	let {
		tasks = [],
		links = [],
		scales = [],
		columns = [],
		readonly = false,
		cellHeight = 36,
		cellWidth = 120,
		scaleHeight = 36,
		cellBorders = "full",
		init = () => {},
	} = $props();

	let api = $state();
</script>

<Willow>
	<ContextMenu {api}>
		<Gantt
			bind:this={api}
			{tasks}
			{links}
			{scales}
			{columns}
			{readonly}
			{cellHeight}
			{cellWidth}
			{scaleHeight}
			{cellBorders}
			{init}
		/>
	</ContextMenu>
	<Editor {api} {readonly} />
</Willow>
