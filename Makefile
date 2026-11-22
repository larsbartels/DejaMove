.PHONY: help build build-core build-ui launch dev test lint format-check package clean

help:
	@echo DejaMove Makefile targets:
	@echo   make build         Build C++ core (Release) and UI without launching
	@echo   make launch        Launch already-built DejaMove desktop app (no rebuild)
	@echo   make dev           Start Vite + Electron hot-reload dev mode
	@echo   make test          Build Debug core and run CTest unit tests
	@echo   make package       Build Release core and package Windows installer/portable app
	@echo   make lint          Run ESLint
	@echo   make format-check  Run Prettier check
	@echo   make clean         Remove built UI dist and release artifacts

build: build-core build-ui

build-core:
	@node -e "const fs=require('fs'),cp=require('child_process');if(!fs.existsSync('core/build/CMakeCache.txt')){cp.execFileSync('cmake',['-S','core','-B','core/build'],{stdio:'inherit'});}"
	cmake --build core/build --config Release --target dejamove-core

build-ui:
	npm --prefix ui run build

launch:
	node scripts/launch.mjs

dev:
	npm --prefix ui run dev

test:
	@node -e "const fs=require('fs'),cp=require('child_process');if(!fs.existsSync('core/build/CMakeCache.txt')){cp.execFileSync('cmake',['-S','core','-B','core/build'],{stdio:'inherit'});}"
	cmake --build core/build --config Debug
	ctest --test-dir core/build -C Debug --output-on-failure

lint:
	npm run lint

format-check:
	npm run format:check

package: build-core
	npm --prefix ui run package

clean:
	@node -e "const fs=require('fs');for(const p of ['ui/dist','ui/dist-electron','ui/release']){fs.rmSync(p,{recursive:true,force:true});}"
