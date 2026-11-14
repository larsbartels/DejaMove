cmake_minimum_required(VERSION 3.22)
project(dejamove_core VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)
include(CTest)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON)

FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
    GIT_SHALLOW TRUE
)

FetchContent_Declare(
    chess_library
    GIT_REPOSITORY https://github.com/Disservin/chess-library.git
    GIT_TAG master
    GIT_SHALLOW TRUE
)

FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG v3.7.1
    GIT_SHALLOW TRUE
)

FetchContent_MakeAvailable(nlohmann_json chess_library)

add_library(dejamove_lib STATIC
    src/chess_board.cpp
    src/repertoire_graph.cpp
)

target_include_directories(dejamove_lib
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_include_directories(dejamove_lib SYSTEM PRIVATE
    ${chess_library_SOURCE_DIR}/include
)

target_link_libraries(dejamove_lib
    PUBLIC
        nlohmann_json::nlohmann_json
)

if(MSVC)
    target_compile_options(dejamove_lib PRIVATE /W4 /permissive- /utf-8)
else()
    target_compile_options(dejamove_lib PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(BUILD_TESTING)
    FetchContent_MakeAvailable(Catch2)

    add_executable(dejamove_tests
        tests/chess_board_test.cpp
        tests/repertoire_graph_test.cpp
    )

    target_link_libraries(dejamove_tests
        PRIVATE
            dejamove_lib
            Catch2::Catch2WithMain
    )

    if(MSVC)
        target_compile_options(dejamove_tests PRIVATE /W4 /permissive- /utf-8)
    else()
        target_compile_options(dejamove_tests PRIVATE -Wall -Wextra -Wpedantic)
    endif()

    list(APPEND CMAKE_MODULE_PATH ${catch2_SOURCE_DIR}/extras)
    include(Catch)
    catch_discover_tests(dejamove_tests)
endif()
